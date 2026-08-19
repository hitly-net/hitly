"""
HITLy + LangGraph refund graph demo.

The refund graph pauses with interrupt(HumanInterrupt) and notifies HITLy.
Reviewer accepts or rejects. On reject, the refund is NOT issued.

**Security**: Resume verification with HITLY_RESUME_SECRET prevents spoofed resumes.
"""

from typing import TypedDict, Literal
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command
from langchain_core.runnables import RunnableConfig

from .hitly import HitlyApprovalConfig, notify_hitly_approval, verify_hitly_resume, HitlyResumeError


async def notify_node(state: RefundState, config: RunnableConfig) -> RefundState:
    """
    Notify HITLy that approval is required.
    
    This node runs once before the interrupt. Previous nodes do not re-run.
    """
    thread_id = config.get("configurable", {}).get("thread_id", "unknown")
    hitly_config = HitlyApprovalConfig()
    
    risk_tier = "high" if state["amount"] > 1000 else "medium" if state["amount"] > 100 else "low"
    
    await notify_hitly_approval(
        config=hitly_config,
        thread_id=thread_id,
        graph_id="refund-graph",
        action={
            "action": "send-refund",
            "args": {"orderId": state["order_id"], "amount": state["amount"]},
        },
        description=(
            f"Refund of ${state['amount']} for order {state['order_id']}. "
            f"{'High-value' if state['amount'] > 1000 else 'Standard'} refund requires approval."
        ),
        # Evidence fields for audit trail
        system_id=SYSTEM_ID,
        inventory_id=INVENTORY_ID,
        policy_id=POLICY_ID,
        policy_rationale=POLICY_RATIONALE,
        risk_tier=risk_tier,
        tool_name=TOOL_NAME,
        sensitivity=SENSITIVITY,
        data_categories=DATA_CATEGORIES,
    )
    
    return state


# Evidence fields mirror Mastra example
SYSTEM_ID = "refund-graph-prod"
INVENTORY_ID = "ai-inv-refund-graph-v1"
POLICY_ID = "refund-over-100"
POLICY_RATIONALE = "Refunds over $100 require manager approval"
TOOL_NAME = "send_refund"
SENSITIVITY = ["financial"]
DATA_CATEGORIES = ["transaction", "customer"]


class RefundState(TypedDict):
    """State for the refund graph."""
    order_id: str
    amount: float
    approved: bool | None
    refund_issued: bool
    rejection_reason: str | None


async def notify_node(state: RefundState, config: RunnableConfig) -> RefundState:
    """
    Pause for HITLy reviewer before issuing refund.
    
    This node only does interrupt + verify. Notify happened in the previous node.
    
    On resume with type=='ignore' (HITLy reject), do not issue refund.
    On accept, proceed to issue_refund_node.
    
    **Security**: Verifies HITLY_RESUME_SECRET to prevent spoofed resumes.
    """
    thread_id = config.get("configurable", {}).get("thread_id", "unknown")
    hitly_config = HitlyApprovalConfig()
    
    # Interrupt and wait for HITLy resume
    human_response = interrupt(
        {
            "action_request": {
                "action": "send-refund",
                "args": {"orderId": state["order_id"], "amount": state["amount"]},
            },
            "config": {"allow_accept": True, "allow_ignore": True},
            "description": f"Refund approval required for ${state['amount']}",
        }
    )
    
    # Verify HITLy resume proof (fail-closed: guessed threadId is rejected)
    try:
        verify_hitly_resume(
            human_response,
            run_id=thread_id,
            secret=hitly_config.resume_secret,
            required=True,
        )
    except HitlyResumeError as e:
        print(f"⚠️  Resume verification failed: {e}")
        return {
            **state,
            "approved": False,
            "refund_issued": False,
            "rejection_reason": f"Resume verification failed: {e}",
        }
    
    # Check resume response type
    if isinstance(human_response, dict):
        response_type = human_response.get("type")
        if response_type == "ignore":
            # HITLy reject: do not issue refund
            return {
                **state,
                "approved": False,
                "refund_issued": False,
                "rejection_reason": "Reviewer rejected the refund",
            }
        elif response_type == "accept":
            return {**state, "approved": True}
        elif response_type == "edit":
            # Apply edited args if provided
            args = human_response.get("args", {})
            return {
                **state,
                "order_id": args.get("orderId", state["order_id"]),
                "amount": args.get("amount", state["amount"]),
                "approved": True,
            }
    
    # Default: approved
    return {**state, "approved": True}


def issue_refund_node(state: RefundState) -> RefundState:
    """Mock-issue the refund after approval."""
    print(f"✓ Refund of ${state['amount']} issued for order {state['order_id']}")
    return {**state, "refund_issued": True}


def should_issue_refund(state: RefundState) -> Literal["issue_refund", "rejected"]:
    """Router: issue refund only if approved."""
    if state.get("approved"):
        return "issue_refund"
    return "rejected"


# Build the graph
builder = StateGraph(RefundState)
builder.add_node("notify", notify_node)
builder.add_node("approval", approval_node)
builder.add_node("issue_refund", issue_refund_node)
builder.add_edge(START, "notify")
builder.add_edge("notify", "approval")
builder.add_conditional_edges(
    "approval",
    should_issue_refund,
    {"issue_refund": "issue_refund", "rejected": END},
)
builder.add_edge("issue_refund", END)

# Compile with checkpointer (required for interrupt)
checkpointer = MemorySaver()
refund_graph = builder.compile(checkpointer=checkpointer)
