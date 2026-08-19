# HITLy + Temporal demo

Human-in-the-loop refund approval using Temporal `condition()`.

## Story

The **refund workflow** pauses with `await condition(() => decision !== undefined, timeout)` and notifies HITLy. A reviewer accepts or rejects in the HITLy inbox. On reject (`decision: 'reject'`), the refund is **not** issued. On accept (`decision: 'accept'`), the workflow resumes and mock-issues the refund.

**HITLy does NOT hold a Temporal worker.** Resume is **signal only** (`hitly.decision`). No start, no signal-with-start.

## Setup

1. Start HITLy (`yarn db:up`, `yarn db:migrate`, `yarn dev:app`) and create a Temporal project. Copy the project id and API key from the project page.
2. Copy `.env.example` to `.env` and set `HITLY_API_KEY`, `HITLY_PROJECT_ID`, `TEMPORAL_ADDRESS`, and `TEMPORAL_NAMESPACE`.
3. Point the HITLy project origin base URL at `TEMPORAL_ADDRESS` (e.g. `localhost:7233` for local).

Install dependencies from the root:

```bash
yarn install
```

## Run the demo

### 1. Start Temporal server

Run a local Temporal server (if you don't have one):

```bash
temporal server start-dev
```

This starts Temporal at `localhost:7233` with the `default` namespace.

### 2. Start the worker

The worker runs the workflow and activities:

```bash
cd examples/temporal
yarn worker
```

### 3. Start a workflow

In another terminal, start the refund workflow:

```bash
cd examples/temporal
yarn start-workflow
```

This starts a workflow with `workflowId: refund-OR-1234` and `orderId: OR-1234`, `amount: 123.45`.

The workflow pauses after the `notifyHitly` activity. Open the HITLy inbox at http://localhost:3001/inbox to approve or reject.

When you **accept** in HITLy, the workflow resumes and issues the refund.  
When you **reject** in HITLy, the workflow bails without issuing the refund.

## Evidence fields

The demo sends complete evidence for the audit trail:

- `systemId`: `refund-workflow-prod` (the AI system being governed)
- `inventoryId`: `ai-inv-refund-workflow-v1` (this system's record in your AI inventory/registry)
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

1. **Activity** POSTs to HITLy `/api/v1/approvals` with `plugin: 'temporal'`, `workflowId`, `address`, `namespace`, and evidence fields.
2. **Workflow** calls `condition(() => decision !== undefined, timeout)` to wait for the signal.
3. **HITLy** stores the envelope and shows it in the inbox.
4. **Reviewer** accepts or rejects.
5. **HITLy** signals the workflow with `hitly.decision` and `{ decision, args }`.
6. **Workflow** checks the decision:
   - `accept` → issue refund
   - `reject` → do **not** issue refund
   - `edit` → apply edited args, then issue refund

## Workflow Structure

The workflow splits notification and decision logic:

1. **notifyHitly** activity — POSTs to HITLy (runs once)
2. **Workflow** — calls `condition()` to wait for signal, then checks decision

**Signal name:** `hitly.decision`  
**Signal payload:** `{ decision: 'accept' | 'reject' | 'edit', args?: { orderId, amount } }`

## Checkpointer requirement

**Checkpointer N/A.** Temporal workflows are durably persisted by default. `condition()` timeout is the **workflow's** problem — HITLy stays pending until decide/expiry/cancel.

**Fail-closed note:** Sink 5xx / hang >5s → pending, no signal, store-failed UI. Already shipped #22.

**Isolation:** A's workflowId is never signaled with B's credentials/namespace. B deciding A is 404.

## Production notes

HITLy must reach `address` to signal workflows. Do not point a hosted HITLy workspace at `localhost`. Use Temporal Cloud or a publicly accessible Temporal server.

For Temporal Cloud, set:

```
TEMPORAL_ADDRESS=your-namespace.tmprl.cloud:7233
TEMPORAL_NAMESPACE=your-namespace.production
TEMPORAL_API_KEY=your-api-key
```

And configure the Temporal connection in HITLy with the address, namespace, and API key.

## Decision mapping

| HITLy | Signal payload |
| --- | --- |
| `accept` | `{ decision: 'accept' }` |
| `edit` | `{ decision: 'edit', args: { orderId, amount } }` |
| `reject` | `{ decision: 'reject' }` |

## Related

- [Temporal docs](https://docs.temporal.io/design-patterns/approval)
- [HITLy integrations](https://hitly.net/integrations/temporal)
- [Envelope](/docs/envelope)
