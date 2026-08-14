# Hitly + Mastra demo

Two human-in-the-loop examples you can run in [Mastra Studio](https://mastra.ai/docs/studio/overview) (`mastra dev`, http://localhost:4111):

1. **Refund agent** — chat with the agent. When it calls `send-refund`, the tool notifies Hitly and `suspend()`s until a reviewer decides. The tool accepts `contextMarkdown`, `externalUrls`, and declared `attachments` (PDF upload later); if markdown is omitted it sends `Refund of {amount} for {orderId}.`
2. **Refund workflow** — run the workflow from Studio. The `hitly-approval` step notifies Hitly and suspends; reject maps to `bail()`.

## Setup

1. Start Hitly (`yarn db:up`, `yarn db:migrate`, `yarn dev:app`) and create a Mastra project. Copy the project id and API key from the project page.
2. Copy `.env.example` to `.env` and set `HITLY_API_KEY`, `HITLY_PROJECT_ID`, and `HITLY_RESUME_SECRET` (from the Hitly project Config page). Zod `resumeSchema` uses `.passthrough()` so the signed `hitly` proof is not stripped on resume.
3. Point the Hitly project origin base URL at `http://localhost:4111` (or set `MASTRA_BASE_URL`).
4. Confirm the OpenAI-compatible server is up at `OPENAI_BASE_URL`.

```bash
yarn dev:mastra
```

Open Studio at http://localhost:4111. Chat with **Refund Agent**, or run **refund-workflow** with `{ "orderId": "1842", "amount": 42.5 }`. Approve in the Hitly inbox at http://localhost:3001/inbox.

The local model defaults:

```
OPENAI_BASE_URL=http://192.168.10.199:1234/v1
MASTRA_MODEL=qwen3.6-35b-a3b-mtp
```
