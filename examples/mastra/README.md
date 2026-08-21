# HITLy + Mastra demo

Two human-in-the-loop examples you can run in [Mastra Studio](https://mastra.ai/docs/studio/overview) (`mastra dev`, http://localhost:4111):

1. **Refund agent** — chat with the agent. When it calls `send-refund`, the tool notifies HITLy and `suspend()`s until a reviewer decides. The tool accepts `contextMarkdown`, `externalUrls` (with optional labels: `{ url, label? }`), and declared `attachments` (PDF upload later); if markdown is omitted it sends `Refund of {amount} for {orderId}.`
2. **Refund workflow** — run the workflow from Studio. The `hitly-approval` step notifies HITLy and suspends; reject maps to `bail()`.

## Setup

1. Start HITLy (`yarn db:up`, `yarn db:migrate`, `yarn dev:app`) and create a Mastra project. Copy the project id and API key from the project page.
2. Copy `.env.example` to `.env` and set `HITLY_API_KEY`, `HITLY_PROJECT_ID`, and `HITLY_RESUME_SECRET` (from the HITLy project Config page). Zod `resumeSchema` uses `.passthrough()` so the signed `hitly` proof is not stripped on resume.
3. Point the HITLy project origin base URL at `http://localhost:4111` (or set `MASTRA_BASE_URL`).
4. Confirm the OpenAI-compatible server is up at `OPENAI_BASE_URL`.

```bash
yarn dev:mastra
```

Open Studio at http://localhost:4111. Chat with **Refund Agent**, or run **refund-workflow** with `{ "orderId": "1842", "amount": 42.5 }`. Approve in the HITLy inbox at http://localhost:3001/inbox.

For more on envelope fields and decision context URLs, see [hitly.net/docs](https://hitly.net/docs).

The local model defaults:

```
OPENAI_BASE_URL=http://192.168.10.199:1234/v1
MASTRA_MODEL=qwen3.6-35b-a3b-mtp
```

## Evidence Fields

Both examples send complete evidence for the audit trail:

- `systemId`: `refund-agent-prod` / `refund-workflow-prod` (the AI system being governed)
- `inventoryId`: `ai-inv-refund-agent-v2` / `ai-inv-refund-workflow-v1` (this system's record in your AI inventory/registry)
- `policyId`: `refund-over-100` (policy requiring approval)
- `policyRationale`: Why approval is required
- `riskTier`: `high` (>$1000), `medium` (>$100), or `low`
- `toolName`: `send_refund`
- `sensitivity`: `["financial"]`
- `dataCategories`: `["transaction", "customer"]`

Evidence events are written to the HTTP sink configured in project settings. To demo the evidence receiver:

1. Run `examples/evidence-http` on port 3100 (or set `PORT`)
2. In Hitly project settings, set Evidence Storage:
   - Type: HTTP
   - URL: `http://localhost:3100/events`
3. Test the sink (button next to URL field)
4. Approve a refund in Hitly
5. Check `examples/evidence-http/events/*.json` for the evidence chain

Each approval creates 3-4 evidence events:
- `requested` (ingest)
- `decided` (reviewer decision, **fail-closed**: origin NOT resumed if sink fails)
- `resumed` or `resume_failed` (origin outcome)
