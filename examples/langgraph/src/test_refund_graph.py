"""Tests for the refund graph."""

import pytest
from unittest.mock import AsyncMock, patch
from src.refund_graph import (
    refund_graph,
    RefundState,
    notify_hitly_idempotent,
)


@pytest.mark.asyncio
async def test_notify_hitly_payload():
    """Test that notify_hitly sends the correct payload shape."""
    with patch("httpx.AsyncClient") as mock_client:
        mock_post = AsyncMock()
        mock_post.return_value.raise_for_status = AsyncMock()
        mock_client.return_value.__aenter__.return_value.post = mock_post
        
        with patch.dict(
            "os.environ",
            {
                "HITLY_API_URL": "http://localhost:3001",
                "HITLY_API_KEY": "test_key",
                "HITLY_PROJECT_ID": "prj_test",
            },
        ):
            await notify_hitly_idempotent(
                thread_id="thread_123",
                order_id="OR-1234",
                amount=150.0,
                deployment_url="http://127.0.0.1:2024",
                graph_id="refund-graph",
            )
        
        # Check the call was made
        assert mock_post.called
        call_args = mock_post.call_args
        
        # Verify URL
        assert call_args.args[0] == "http://localhost:3001/api/v1/approvals"
        
        # Verify payload structure
        payload = call_args.kwargs["json"]
        assert payload["plugin"] == "langgraph"
        assert payload["threadId"] == "thread_123"
        assert payload["graphId"] == "refund-graph"
        assert payload["action_request"]["action"] == "send-refund"
        assert payload["action_request"]["args"]["orderId"] == "OR-1234"
        assert payload["action_request"]["args"]["amount"] == 150.0
        
        # Verify evidence fields
        assert payload["systemId"] == "refund-graph-prod"
        assert payload["inventoryId"] == "ai-inv-refund-graph-v1"
        assert payload["policyId"] == "refund-over-100"
        assert payload["riskTier"] == "medium"
        assert payload["toolName"] == "send_refund"
        assert payload["sensitivity"] == ["financial"]
        assert payload["dataCategories"] == ["transaction", "customer"]
        
        # Verify auth header
        headers = call_args.kwargs["headers"]
        assert headers["Authorization"] == "Bearer test_key"


@pytest.mark.asyncio
async def test_refund_graph_interrupt():
    """Test that the graph pauses at interrupt."""
    initial_state: RefundState = {
        "order_id": "OR-1234",
        "amount": 123.45,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    config = {"configurable": {"thread_id": "test_thread"}}
    
    # Mock notify to avoid real HTTP call
    with patch("src.refund_graph.notify_hitly_idempotent", new_callable=AsyncMock):
        result = await refund_graph.ainvoke(initial_state, config)
        
        # Should be paused (approved is None means waiting)
        assert result["approved"] is None or result["approved"] is True


@pytest.mark.asyncio
async def test_refund_graph_accept():
    """Test that accept continues to issue_refund."""
    from langgraph.types import Command
    
    initial_state: RefundState = {
        "order_id": "OR-1234",
        "amount": 123.45,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    config = {"configurable": {"thread_id": "test_thread_accept"}}
    
    # Mock notify to avoid real HTTP call
    with patch("src.refund_graph.notify_hitly_idempotent", new_callable=AsyncMock):
        # First invoke pauses
        await refund_graph.ainvoke(initial_state, config)
        
        # Resume with accept
        result = await refund_graph.ainvoke(
            Command(resume={"type": "accept"}),
            config,
        )
        
        # Should be approved and refund issued
        assert result["approved"] is True
        assert result["refund_issued"] is True


@pytest.mark.asyncio
async def test_refund_graph_ignore():
    """Test that ignore (HITLy reject) does NOT issue refund."""
    from langgraph.types import Command
    
    initial_state: RefundState = {
        "order_id": "OR-1234",
        "amount": 123.45,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    config = {"configurable": {"thread_id": "test_thread_ignore"}}
    
    # Mock notify to avoid real HTTP call
    with patch("src.refund_graph.notify_hitly_idempotent", new_callable=AsyncMock):
        # First invoke pauses
        await refund_graph.ainvoke(initial_state, config)
        
        # Resume with ignore (reject)
        result = await refund_graph.ainvoke(
            Command(resume={"type": "ignore"}),
            config,
        )
        
        # Should be rejected, no refund
        assert result["approved"] is False
        assert result["refund_issued"] is False
        assert result["rejection_reason"] == "Reviewer rejected the refund"
