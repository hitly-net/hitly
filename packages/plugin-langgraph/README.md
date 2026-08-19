# @hitly/plugin-langgraph

LangGraph adapter: ingest a `HumanInterrupt`, resume the origin thread with `HumanResponse`.

## Usage

This plugin is already registered in the HITLy app. When LangGraph calls `interrupt(HumanInterrupt)` and posts to `/api/v1/approvals`, HITLy ingests it and stores an envelope. When a reviewer decides, HITLy resumes the thread via `POST /threads/{threadId}/runs/wait` with `{ command: { resume: HumanResponse } }`.

## Ingest payload

```json
{
  "plugin": "langgraph",
  "projectId": "prj_...",
  "threadId": "thread_123",
  "deploymentUrl": "http://127.0.0.1:2024",
  "graphId": "refund-graph",
  "action_request": {
    "action": "send-refund",
    "args": { "orderId": "OR-1234", "amount": 123.45 }
  },
  "config": {
    "allow_accept": true,
    "allow_ignore": true
  },
  "description": "Refund approval required"
}
```

Optional evidence fields: `systemId`, `inventoryId`, `policyId`, `policyRationale`, `riskTier`, `toolName`, `sensitivity`, `dataCategories`.

## Resume

HITLy calls `POST {deploymentUrl}/threads/{threadId}/runs/wait` with:

```json
{
  "assistant_id": "refund-graph",
  "command": {
    "resume": {
      "type": "accept"
    }
  }
}
```

Decision mapping:

| HITLy | HumanResponse |
| --- | --- |
| `accept` | `{ type: 'accept' }` |
| `edit` | `{ type: 'edit', args: ActionRequest }` |
| `respond` | `{ type: 'response', args: string }` |
| `ignore` / `reject` | `{ type: 'ignore' }` |

## Example

See `examples/langgraph` for a complete refund approval demo with FastAPI + LangGraph.

## Healthcheck

HITLy checks `GET {deploymentUrl}/ok` or `GET {deploymentUrl}/info` to validate the connection.

## Related

- [LangGraph docs](https://langchain-ai.github.io/langgraph/)
- [HITLy integrations](https://hitly.net/integrations/langgraph)

