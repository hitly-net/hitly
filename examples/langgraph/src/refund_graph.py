"""
HITLy + LangGraph refund graph demo.

The refund graph pauses with interrupt(HumanInterrupt) and notifies HITLy.
Reviewer accepts or rejects. On reject, the refund is NOT issued.
"""

from typing import TypedDict, Annotated, Literal
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command
from langchain_core.runnables import RunnableConfig
import httpx
import os

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


class HumanInterrupt:
    """
    LangGraph HumanInterrupt for pausing the graph.
    Maps to HITLy envelope via action_request, config, description.
    """
    def __init__(
        self,
        action_request: dict,
        config: dict | None = None,
        description: str | None = None,
    ):
        self.action_request = action_request
        self.config = config or {}
        self.description = description


async def notify_hitly_idempotent(
    thread_id: str,
    order_id: str,
    amount: float,
    deployment_url: str,
    graph_id: str,
) -> None:
    """
    Notify HITLy approval endpoint (idempotent).
    
    This is decorated as a LangGraph @task so it only runs once
    even if the node restarts on resume.
    """
    hitly_api_url = os.getenv("HITLY_API_URL", "http://localhost:3001")
    hitly_api_key = os.getenv("HITLY_API_KEY", "")
    hitly_project_id = os.getenv("HITLY_PROJECT_ID", "")
    
    if not hitly_api_key or not hitly_project_id:
        raise ValueError(
            "Set HITLY_API_KEY and HITLY_PROJECT_ID in .env "
            "(copy from HITLy project page)"
        )
    
    risk_tier = "high" if amount > 1000 else "medium" if amount > 100 else "low"
    
    payload = {
        "plugin": "langgraph",
        "projectId": hitly_project_id,
        "threadId": thread_id,
        "deploymentUrl": deployment_url,
        "graphId": graph_id,
        "action_request": {
            "action": "send-refund",
            "args": {"orderId": order_id, "amount": amount},
        },
        "config": {
            "allow_accept": True,
            "allow_ignore": True,
        },
        "description": (
            f"Refund of ${amount} for order {order_id}. "
            f"{'High-value' if amount > 1000 else 'Standard'} refund requires approval."
        ),
        # Evidence fields for audit trail
        "systemId": SYSTEM_ID,
        "inventoryId": INVENTORY_ID,
        "policyId": POLICY_ID,
        "policyRationale": POLICY_RATIONALE,
        "riskTier": risk_tier,
        "toolName": TOOL_NAME,
        "sensitivity": SENSITIVITY,
        "dataCategories": DATA_CATEGORIES,
    }
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{hitly_api_url.rstrip('/')}/api/v1/approvals",
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {hitly_api_key}",
            },
        )
        response.raise_for_status()


async def approval_node(state: RefundState, config: RunnableConfig) -> RefundState:
    """
    Pause for HITLy reviewer before issuing refund.
    
    On resume with type=='ignore' (HITLy reject), do not issue refund.
    On accept, proceed to issue_refund_node.
    """
    # Extract thread_id from config
    thread_id = config.get("configurable", {}).get("thread_id", "unknown")
    deployment_url = os.getenv("LANGGRAPH_BASE_URL", "http://127.0.0.1:2024")
    graph_id = "refund-graph"
    
    # Idempotent notify: wrapped in a task so it only runs once
    # even if the node restarts on resume
    from langgraph.prebuilt import task
    
    @task
    async def notify_once():
        await notify_hitly_idempotent(
            thread_id=thread_id,
            order_id=state["order_id"],
            amount=state["amount"],
            deployment_url=deployment_url,
            graph_id=graph_id,
        )
    
    await notify_once()
    
    # Interrupt and wait for HITLy resume
    human_response = interrupt(
        HumanInterrupt(
            action_request={
                "action": "send-refund",
                "args": {"orderId": state["order_id"], "amount": state["amount"]},
            },
            config={"allow_accept": True, "allow_ignore": True},
            description=f"Refund approval required for ${state['amount']}",
        )
    )
    
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
builder.add_node("approval", approval_node)
builder.add_node("issue_refund", issue_refund_node)
builder.add_edge(START, "approval")
builder.add_conditional_edges(
    "approval",
    should_issue_refund,
    {"issue_refund": "issue_refund", "rejected": END},
)
builder.add_edge("issue_refund", END)

# Compile with checkpointer (required for interrupt)
checkpointer = MemorySaver()
refund_graph = builder.compile(checkpointer=checkpointer)
