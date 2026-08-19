# HITLy + LangGraph demo

Human-in-the-loop refund approval using LangGraph `interrupt(HumanInterrupt)`.

## Story

The **refund graph** pauses with `interrupt(HumanInterrupt)` and notifies HITLy. A reviewer accepts or rejects in the HITLy inbox. On reject (`type: 'ignore'`), the refund is **not** issued. On accept (`type: 'accept'`), the graph resumes and mock-issues the refund.

## Setup

1. Start HITLy (`yarn db:up`, `yarn db:migrate`, `yarn dev:app`) and create a LangGraph project. Copy the project id and API key from the project page.
2. Copy `.env.example` to `.env` and set `HITLY_API_KEY`, `HITLY_PROJECT_ID`.
3. Point the HITLy project origin base URL at `http://127.0.0.1:2024` (or set `LANGGRAPH_BASE_URL`).

Install Python dependencies:

```bash
cd examples/langgraph
pip install -e .
```

Or with a virtual environment:

```bash
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -e .
```

## Run the demo

Start the FastAPI server:

```bash
python -m src.server
```

The server listens on `http://127.0.0.1:2024` by default. Open http://127.0.0.1:2024 for the API docs.

### Create a refund thread

```bash
curl -X POST http://127.0.0.1:2024/refund \
  -H 'Content-Type: application/json' \
  -d '{"order_id": "OR-1234", "amount": 123.45}'
```

The graph pauses at the `approval` node. Open the HITLy inbox at http://localhost:3001/inbox to approve or reject.

When you **accept**, the graph resumes and issues the refund.  
When you **reject**, the graph bails without issuing the refund.

## Evidence fields

The demo sends complete evidence for the audit trail:

- `systemId`: `refund-graph-prod` (the AI system being governed)
- `inventoryId`: `ai-inv-refund-graph-v1` (this system's record in your AI inventory/registry)
- `policyId`: `refund-over-100` (policy requiring approval)
- `policyRationale`: Why approval is required
- `riskTier`: `high` (>$1000), `medium` (>$100), or `low`
- `toolName`: `send_refund`
- `sensitivity`: `["financial"]`
- `dataCategories`: `["transaction", "customer"]`

Evidence events are written to the HTTP sink configured in project settings. To demo the evidence receiver:

1. Run `examples/evidence-http` on port 3100 (or set `PORT`)
2. In HITLy project settings, set Evidence Storage:
   - Type: HTTP
   - URL: `http://localhost:3100/events`
3. Test the sink (button next to URL field)
4. Approve a refund in HITLy
5. Check `examples/evidence-http/events/*.json` for the evidence chain

Each approval creates 3-4 evidence events:
- `requested` (ingest)
- `decided` (reviewer decision, **fail-closed**: origin NOT resumed if sink fails)
- `resumed` or `resume_failed` (origin outcome)

## How it works

1. **Graph node** calls `interrupt(HumanInterrupt)` and notifies HITLy (idempotent POST to `/api/v1/approvals`).
2. **HITLy** stores the envelope and shows it in the inbox.
3. **Reviewer** accepts or rejects.
4. **HITLy** resumes the thread with `POST /threads/{thread_id}/runs/wait` and `{ command: { resume: <HumanResponse> } }`.
5. **Graph** checks `response.type`:
   - `accept` → issue refund
   - `ignore` (HITLy reject) → do **not** issue refund, return rejection reason
   - `edit` → apply edited args, then issue refund

## Testing

Run the Python tests:

```bash
pytest src/test_refund_graph.py -v
```

Tests verify:
- Notify payload shape (mocked httpx)
- Interrupt happens
- `Command(resume={'type': 'accept'})` continues and issues refund
- `Command(resume={'type': 'ignore'})` does **not** issue refund

## Production notes

HITLy must reach `deploymentUrl` to call `POST /threads/{thread_id}/runs/wait`. Do not point a hosted HITLy workspace at `localhost`. Use LangGraph Cloud or a publicly accessible deployment.

For LangGraph Cloud, set:

```
LANGGRAPH_BASE_URL=https://your-deployment.langchain.app
```

And configure the LangGraph connection in HITLy with the deployment URL and API token.

## Idempotent notify

The `notify_hitly_idempotent` call is wrapped in a LangGraph `@task` so it only runs **once** even if the node restarts on resume. Without this, the node would double-ingest on resume.

## Decision mapping

| HITLy | HumanResponse |
| --- | --- |
| `accept` | `{ type: 'accept' }` |
| `edit` | `{ type: 'edit', args: ActionRequest }` |
| `respond` | `{ type: 'response', args: string }` |
| `ignore` / `reject` | `{ type: 'ignore' }` |

## Related

- [LangGraph docs](https://langchain-ai.github.io/langgraph/)
- [HITLy integrations](https://hitly.net/integrations/langgraph)
- [Envelope](/docs/envelope)
