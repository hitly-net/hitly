"""
FastAPI server with LangGraph Platform-compatible routes.

Implements:
- POST /threads + /threads/{thread_id}/runs — start a refund thread
- POST /threads/{thread_id}/runs/wait — resume with HumanResponse

Start with: python -m src.server
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any
import uvicorn
import os
from dotenv import load_dotenv

from .refund_graph import refund_graph, RefundState

load_dotenv()

app = FastAPI(title="HITLy LangGraph Demo")

# In-memory thread storage (use SqliteSaver for persistence)
threads: dict[str, dict] = {}
thread_counter = 0


class CreateThreadRequest(BaseModel):
    """Request to create a new thread."""
    order_id: str = "OR-1234"
    amount: float = 123.45


class ResumeRequest(BaseModel):
    """LangGraph Platform resume request."""
    assistant_id: str | None = None
    command: dict[str, Any]


@app.post("/refund")
async def create_refund_thread(req: CreateThreadRequest):
    """
    Start a refund thread.
    
    Returns thread_id and HITLy inbox URL.
    """
    global thread_counter
    thread_counter += 1
    thread_id = f"thread_{thread_counter}"
    
    # Start the graph
    config = {"configurable": {"thread_id": thread_id}}
    initial_state: RefundState = {
        "order_id": req.order_id,
        "amount": req.amount,
        "approved": None,
        "refund_issued": False,
        "rejection_reason": None,
    }
    
    try:
        # Invoke will pause at interrupt
        result = await refund_graph.ainvoke(initial_state, config)
        threads[thread_id] = {"state": result, "config": config}
        
        hitly_api_url = os.getenv("HITLY_API_URL", "http://localhost:3001")
        inbox_url = f"{hitly_api_url.rstrip('/')}/inbox"
        
        return {
            "thread_id": thread_id,
            "status": "interrupted" if result.get("approved") is None else "completed",
            "state": result,
            "inbox_url": inbox_url,
            "message": (
                f"Refund paused for approval. Open {inbox_url} to approve/reject."
                if result.get("approved") is None
                else "Refund completed"
            ),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/threads/{thread_id}/runs/wait")
async def resume_thread(thread_id: str, req: ResumeRequest):
    """
    LangGraph Platform-compatible resume endpoint.
    
    HITLy calls this with:
    {
      "assistant_id": "refund-graph",
      "command": { "resume": <HumanResponse> }
    }
    """
    if thread_id not in threads:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    thread_data = threads[thread_id]
    config = thread_data["config"]
    
    # Extract HumanResponse from command
    resume_value = req.command.get("resume")
    if not resume_value:
        raise HTTPException(status_code=400, detail="Missing resume in command")
    
    try:
        # Resume the graph with the HumanResponse
        result = await refund_graph.ainvoke(
            Command(resume=resume_value),
            config,
        )
        threads[thread_id]["state"] = result
        
        return {
            "thread_id": thread_id,
            "status": "completed" if result.get("refund_issued") or result.get("rejection_reason") else "running",
            "state": result,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/ok")
async def healthcheck_ok():
    """Healthcheck endpoint for HITLy plugin."""
    return {"status": "ok"}


@app.get("/info")
async def healthcheck_info():
    """Alternative healthcheck endpoint."""
    return {
        "name": "HITLy LangGraph Demo",
        "version": "0.0.1",
        "graphs": ["refund-graph"],
    }


@app.get("/")
async def root():
    """Root endpoint with instructions."""
    return {
        "message": "HITLy + LangGraph refund demo",
        "endpoints": {
            "POST /refund": "Start a refund thread (default: OR-1234, $123.45)",
            "POST /threads/{thread_id}/runs/wait": "Resume thread (HITLy calls this)",
            "GET /ok": "Healthcheck",
        },
        "example": {
            "create": "POST /refund with {\"order_id\": \"OR-1234\", \"amount\": 123.45}",
            "resume": "POST /threads/{thread_id}/runs/wait with {\"command\": {\"resume\": {\"type\": \"accept\"}}}",
        },
    }


def main():
    """Start the server."""
    port = int(os.getenv("PORT", "2024"))
    print(f"\n🚀 HITLy LangGraph Demo starting on http://127.0.0.1:{port}")
    print(f"📋 HITLy Inbox: {os.getenv('HITLY_API_URL', 'http://localhost:3001')}/inbox")
    print(f"\nExample request:")
    print(f"  curl -X POST http://127.0.0.1:{port}/refund \\\n    -H 'Content-Type: application/json' \\\n    -d '{{\"order_id\": \"OR-1234\", \"amount\": 123.45}}'\n")
    
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
