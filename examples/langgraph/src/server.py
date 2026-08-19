"""
FastAPI server with LangGraph Platform-compatible routes.

Implements:
- POST /threads + /threads/{thread_id}/runs — start a refund thread
- POST /threads/{thread_id}/runs/wait — resume with HumanResponse

Start with: python -m src.server
"""

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel
from typing import Any
import uvicorn
import os
from dotenv import load_dotenv

from langgraph.types import Command
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


@app.get("/threads/{thread_id}/status")
async def get_thread_status(thread_id: str):
    """Get current thread status for polling."""
    if thread_id not in threads:
        raise HTTPException(status_code=404, detail="Thread not found")
    
    thread_data = threads[thread_id]
    state = thread_data["state"]
    
    # Determine status
    if state.get("refund_issued"):
        status = "completed"
        outcome = "issued"
    elif state.get("rejection_reason"):
        status = "completed"
        outcome = "rejected"
    elif state.get("approved") is None:
        status = "interrupted"
        outcome = "waiting"
    else:
        status = "running"
        outcome = "processing"
    
    return {
        "thread_id": thread_id,
        "status": status,
        "outcome": outcome,
        "state": state,
    }


@app.get("/", response_class=HTMLResponse)
async def root():
    """Web UI for refund demo."""
    hitly_api_url = os.getenv("HITLY_API_URL", "http://localhost:3001")
    inbox_url = f"{hitly_api_url.rstrip('/')}/inbox"
    
    return f"""
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HITLy + LangGraph Demo</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }}
        .container {{
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 600px;
            width: 100%;
            padding: 40px;
        }}
        .logo {{
            text-align: center;
            margin-bottom: 32px;
        }}
        .logo h1 {{
            font-size: 36px;
            font-weight: 700;
            color: #667eea;
            margin-bottom: 8px;
        }}
        .logo .sub {{
            font-style: italic;
            font-size: 0.65em;
            line-height: 1;
        }}
        .logo .subtitle {{
            font-size: 14px;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 1px;
        }}
        .card {{
            background: #f9fafb;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 24px;
        }}
        .card h2 {{
            font-size: 18px;
            color: #1f2937;
            margin-bottom: 12px;
        }}
        .card .detail {{
            display: flex;
            justify-content: space-between;
            font-size: 16px;
            color: #4b5563;
            margin-bottom: 8px;
        }}
        .card .detail strong {{
            color: #1f2937;
        }}
        button {{
            width: 100%;
            padding: 16px;
            font-size: 16px;
            font-weight: 600;
            color: white;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: none;
            border-radius: 12px;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }}
        button:hover:not(:disabled) {{
            transform: translateY(-2px);
            box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
        }}
        button:disabled {{
            opacity: 0.6;
            cursor: not-allowed;
        }}
        .status {{
            margin-top: 24px;
            padding: 20px;
            border-radius: 12px;
            text-align: center;
            display: none;
        }}
        .status.waiting {{
            background: #fef3c7;
            border: 2px solid #fbbf24;
            display: block;
        }}
        .status.completed {{
            background: #d1fae5;
            border: 2px solid #10b981;
            display: block;
        }}
        .status.rejected {{
            background: #fee2e2;
            border: 2px solid #ef4444;
            display: block;
        }}
        .status h3 {{
            font-size: 20px;
            margin-bottom: 12px;
            color: #1f2937;
        }}
        .status p {{
            font-size: 14px;
            color: #4b5563;
            margin-bottom: 16px;
        }}
        .status a {{
            display: inline-block;
            padding: 12px 24px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
            transition: background 0.2s;
        }}
        .status a:hover {{
            background: #764ba2;
        }}
        .spinner {{
            border: 3px solid #f3f4f6;
            border-top: 3px solid #667eea;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 16px auto;
        }}
        @keyframes spin {{
            0% {{ transform: rotate(0deg); }}
            100% {{ transform: rotate(360deg); }}
        }}
        .result-icon {{
            font-size: 48px;
            margin-bottom: 12px;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <h1>HITL<sub class="sub">y</sub></h1>
            <div class="subtitle">Human-in-the-Loop Platform</div>
        </div>

        <div class="card">
            <h2>Refund Request</h2>
            <div class="detail">
                <span><strong>Order ID:</strong></span>
                <span>OR-1234</span>
            </div>
            <div class="detail">
                <span><strong>Amount:</strong></span>
                <span>$123.45</span>
            </div>
        </div>

        <button id="requestBtn" onclick="requestRefund()">Request Refund</button>

        <div id="statusWaiting" class="status waiting">
            <div class="spinner"></div>
            <h3>Paused — waiting for a HITLy decision</h3>
            <p>A reviewer is evaluating this refund request.</p>
            <a href="{inbox_url}" target="_blank">Open HITLy Inbox →</a>
        </div>

        <div id="statusCompleted" class="status completed">
            <div class="result-icon">✓</div>
            <h3>Refund Issued</h3>
            <p>The reviewer approved the refund request.<br>Refund of $123.45 has been processed for order OR-1234.</p>
        </div>

        <div id="statusRejected" class="status rejected">
            <div class="result-icon">✗</div>
            <h3>Refund Rejected</h3>
            <p>The reviewer declined the refund request.</p>
        </div>
    </div>

    <script>
        let threadId = null;
        let pollInterval = null;

        async function requestRefund() {{
            const btn = document.getElementById('requestBtn');
            btn.disabled = true;
            btn.textContent = 'Starting...';

            try {{
                const response = await fetch('/refund', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ order_id: 'OR-1234', amount: 123.45 }})
                }});

                if (!response.ok) {{
                    throw new Error('Failed to start refund');
                }}

                const data = await response.json();
                threadId = data.thread_id;

                // Show waiting status
                document.getElementById('statusWaiting').style.display = 'block';
                btn.textContent = 'Waiting for approval...';

                // Start polling
                pollInterval = setInterval(pollStatus, 2000);
            }} catch (error) {{
                alert('Error: ' + error.message);
                btn.disabled = false;
                btn.textContent = 'Request Refund';
            }}
        }}

        async function pollStatus() {{
            if (!threadId) return;

            try {{
                const response = await fetch(`/threads/${{threadId}}/status`);
                if (!response.ok) return;

                const data = await response.json();

                if (data.status === 'completed') {{
                    clearInterval(pollInterval);
                    document.getElementById('statusWaiting').style.display = 'none';

                    if (data.outcome === 'issued') {{
                        document.getElementById('statusCompleted').style.display = 'block';
                    }} else if (data.outcome === 'rejected') {{
                        document.getElementById('statusRejected').style.display = 'block';
                    }}

                    document.getElementById('requestBtn').textContent = 'Completed';
                }}
            }} catch (error) {{
                console.error('Poll error:', error);
            }}
        }}
    </script>
</body>
</html>
    """


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
