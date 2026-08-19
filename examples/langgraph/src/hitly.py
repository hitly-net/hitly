"""
HITLy helpers for LangGraph graph authors.

Use these helpers to integrate HITLy approval into your LangGraph graphs.
No need to write HTTP requests yourself.
"""

from typing import Dict, Any, Optional, List
import httpx
import os

from .resume_auth import verify_hitly_resume, HitlyResumeError


class HitlyApprovalConfig:
    """Configuration for HITLy approval integration."""
    
    def __init__(
        self,
        *,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        project_id: Optional[str] = None,
        resume_secret: Optional[str] = None,
        deployment_url: Optional[str] = None,
    ):
        """
        Initialize HITLy configuration.
        
        Args:
            api_url: HITLy API URL (defaults to HITLY_API_URL env var)
            api_key: HITLy API key (defaults to HITLY_API_KEY env var)
            project_id: HITLy project ID (defaults to HITLY_PROJECT_ID env var)
            resume_secret: HITLy resume secret (defaults to HITLY_RESUME_SECRET env var)
            deployment_url: LangGraph deployment URL (defaults to LANGGRAPH_BASE_URL env var)
        """
        self.api_url = api_url or os.getenv("HITLY_API_URL", "http://localhost:3001")
        self.api_key = api_key or os.getenv("HITLY_API_KEY", "")
        self.project_id = project_id or os.getenv("HITLY_PROJECT_ID", "")
        self.resume_secret = resume_secret or os.getenv("HITLY_RESUME_SECRET", "")
        self.deployment_url = deployment_url or os.getenv("LANGGRAPH_BASE_URL", "http://127.0.0.1:2024")
        
        if not self.api_key or not self.project_id:
            raise ValueError(
                "HITLY_API_KEY and HITLY_PROJECT_ID must be set in environment "
                "or passed to HitlyApprovalConfig"
            )
        if not self.resume_secret:
            raise ValueError(
                "HITLY_RESUME_SECRET must be set in environment or passed to HitlyApprovalConfig. "
                "Copy it from the HITLy project Config page."
            )


async def notify_hitly_approval(
    *,
    config: HitlyApprovalConfig,
    thread_id: str,
    graph_id: str,
    action: Dict[str, Any],
    description: Optional[str] = None,
    # Evidence fields (optional)
    system_id: Optional[str] = None,
    inventory_id: Optional[str] = None,
    policy_id: Optional[str] = None,
    policy_rationale: Optional[str] = None,
    risk_tier: Optional[str] = None,
    tool_name: Optional[str] = None,
    sensitivity: Optional[List[str]] = None,
    data_categories: Optional[List[str]] = None,
) -> None:
    """
    Notify HITLy that a LangGraph node is pausing for approval.
    
    Call this before `interrupt(HumanInterrupt(...))` to create an approval
    in the HITLy inbox.
    
    Args:
        config: HITLy configuration
        thread_id: LangGraph thread ID
        graph_id: LangGraph graph ID
        action: Action request dict with 'name' and 'args'
        description: Human-readable description of what needs approval
        system_id: AI system identifier (e.g. "refund-graph-prod")
        inventory_id: AI inventory record ID (Layer 1, not business object ID)
        policy_id: Policy that triggered approval
        policy_rationale: Why approval is required
        risk_tier: Risk level (e.g. "high", "medium", "low")
        tool_name: Tool or action name
        sensitivity: Sensitivity flags (not raw PII)
        data_categories: Data category flags (GDPR/compliance)
        
    Raises:
        httpx.HTTPError: If the HITLy API request fails
    """
    payload = {
        "plugin": "langgraph",
        "projectId": config.project_id,
        "threadId": thread_id,
        "deploymentUrl": config.deployment_url,
        "graphId": graph_id,
        "action_request": action,
        "config": {
            "allow_accept": True,
            "allow_ignore": True,
        },
    }
    
    if description:
        payload["description"] = description
    
    # Add evidence fields if provided
    if system_id:
        payload["systemId"] = system_id
    if inventory_id:
        payload["inventoryId"] = inventory_id
    if policy_id:
        payload["policyId"] = policy_id
    if policy_rationale:
        payload["policyRationale"] = policy_rationale
    if risk_tier:
        payload["riskTier"] = risk_tier
    if tool_name:
        payload["toolName"] = tool_name
    if sensitivity:
        payload["sensitivity"] = sensitivity
    if data_categories:
        payload["dataCategories"] = data_categories
    
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{config.api_url.rstrip('/')}/api/v1/approvals",
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {config.api_key}",
            },
        )
        response.raise_for_status()


__all__ = [
    "HitlyApprovalConfig",
    "notify_hitly_approval",
    "verify_hitly_resume",
    "HitlyResumeError",
]
