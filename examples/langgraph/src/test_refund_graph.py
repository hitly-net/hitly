"""Tests for the refund graph."""

import pytest
from unittest.mock import AsyncMock, patch
from src.refund_graph import (
    refund_graph,
    RefundState,
    notify_hitly_idempotent,
)
from src.resume_auth import verify_hitly_resume, HitlyResumeError


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


def test_verify_hitly_resume_rejects_guessed_threadid():
    """Test that resume verification rejects guessed threadId without proof."""
    # Resume without hitly proof (guessed by attacker)
    guessed_resume = {"type": "accept"}
    
    with patch.dict("os.environ", {"HITLY_RESUME_SECRET": "test_secret"}):
        with pytest.raises(HitlyResumeError, match="proof is missing"):
            verify_hitly_resume(guessed_resume, run_id="thread_123")


def test_verify_hitly_resume_requires_secret():
    """Test that verification requires HITLY_RESUME_SECRET."""
    resume = {"type": "accept", "hitly": {"v": 1, "sig": "fake"}}
    
    with patch.dict("os.environ", {"HITLY_RESUME_SECRET": ""}, clear=True):
        with pytest.raises(HitlyResumeError, match="HITLY_RESUME_SECRET is not set"):
            verify_hitly_resume(resume, required=True)


def test_verify_hitly_resume_rejects_wrong_runid():
    """Test that verification rejects mismatched runId."""
    import time
    
    resume = {
        "type": "accept",
        "hitly": {
            "v": 1,
            "runId": "thread_abc",
            "stepId": "",
            "approvalId": "",
            "nonce": "test",
            "iat": int(time.time()),
            "exp": int(time.time()) + 300,
            "sig": "fake_signature",
        },
    }
    
    with patch.dict("os.environ", {"HITLY_RESUME_SECRET": "test_secret"}):
        with pytest.raises(HitlyResumeError, match="runId does not match"):
            verify_hitly_resume(resume, run_id="thread_xyz")


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
async def test_refund_graph_accept_with_valid_proof():
    """Test that accept with valid HITLy proof continues to issue_refund."""
    from langgraph.types import Command
    import time
    import hmac
    import hashlib
    import json
    
    initial_state: RefundState = {
        "order_id": "OR-1234",
        "amount": 123.45,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    config = {"configurable": {"thread_id": "test_thread_accept"}}
    secret = "test_secret"
    
    # Create a valid HITLy proof
    def stable_json(value):
        return json.dumps(value, separators=(',', ':'), sort_keys=True)
    
    claim = {
        "v": 1,
        "runId": "test_thread_accept",
        "stepId": "",
        "approvalId": "",
        "nonce": "test_nonce",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }
    data = {"type": "accept"}
    payload = f'{stable_json(claim)}.{stable_json(data)}'
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    
    valid_resume = {**data, "hitly": {**claim, "sig": sig}}
    
    # Mock notify and set HITLY_RESUME_SECRET
    with patch("src.refund_graph.notify_hitly_idempotent", new_callable=AsyncMock):
        with patch.dict("os.environ", {"HITLY_RESUME_SECRET": secret}):
            # First invoke pauses
            await refund_graph.ainvoke(initial_state, config)
            
            # Resume with valid signed accept
            result = await refund_graph.ainvoke(
                Command(resume=valid_resume),
                config,
            )
            
            # Should be approved and refund issued
            assert result["approved"] is True
            assert result["refund_issued"] is True


@pytest.mark.asyncio
async def test_refund_graph_rejects_guessed_accept():
    """Test that accept without HITLy proof is rejected."""
    from langgraph.types import Command
    
    initial_state: RefundState = {
        "order_id": "OR-1234",
        "amount": 123.45,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    config = {"configurable": {"thread_id": "test_thread_guessed"}}
    
    # Guessed accept (no hitly proof)
    guessed_resume = {"type": "accept"}
    
    # Mock notify and set HITLY_RESUME_SECRET
    with patch("src.refund_graph.notify_hitly_idempotent", new_callable=AsyncMock):
        with patch.dict("os.environ", {"HITLY_RESUME_SECRET": "test_secret"}):
            # First invoke pauses
            await refund_graph.ainvoke(initial_state, config)
            
            # Resume with guessed accept (no proof)
            result = await refund_graph.ainvoke(
                Command(resume=guessed_resume),
                config,
            )
            
            # Should be rejected, no refund
            assert result["approved"] is False
            assert result["refund_issued"] is False
            assert "verification failed" in result["rejection_reason"].lower()


@pytest.mark.asyncio
async def test_refund_graph_ignore():
    """Test that ignore (HITLy reject) does NOT issue refund."""
    from langgraph.types import Command
    import time
    import hmac
    import hashlib
    import json
    
    initial_state: RefundState = {
        "order_id": "OR-1234",
        "amount": 123.45,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    config = {"configurable": {"thread_id": "test_thread_ignore"}}
    secret = "test_secret"
    
    # Create a valid HITLy proof for ignore
    def stable_json(value):
        return json.dumps(value, separators=(',', ':'), sort_keys=True)
    
    claim = {
        "v": 1,
        "runId": "test_thread_ignore",
        "stepId": "",
        "approvalId": "",
        "nonce": "test_nonce",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }
    data = {"type": "ignore"}
    payload = f'{stable_json(claim)}.{stable_json(data)}'
    sig = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    
    valid_resume = {**data, "hitly": {**claim, "sig": sig}}
    
    # Mock notify and set HITLY_RESUME_SECRET
    with patch("src.refund_graph.notify_hitly_idempotent", new_callable=AsyncMock):
        with patch.dict("os.environ", {"HITLY_RESUME_SECRET": secret}):
            # First invoke pauses
            await refund_graph.ainvoke(initial_state, config)
            
            # Resume with ignore (reject)
            result = await refund_graph.ainvoke(
                Command(resume=valid_resume),
                config,
            )
            
            # Should be rejected, no refund
            assert result["approved"] is False
            assert result["refund_issued"] is False
            assert result["rejection_reason"] == "Reviewer rejected the refund"
