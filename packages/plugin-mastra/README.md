# @hitly/plugin-mastra

Mastra adapter: ingest a suspend payload, resume the origin run after a Hitly decision.

Supports:

- **Workflows** — `POST /api/workflows/:workflowId/resume-async` (waits for the run result)
- **Agents** — `POST /api/agents/:agentId/resume-stream` after a tool calls `suspend()`

Resume returns `{ resumeData, status, body }` so Hitly can store the origin response on the inbox item.

`signHitlyResume` attaches a `hitly` proof on `resumeData`. Mastra Zod `resumeSchema` strips unknown keys by default, so origin steps must use `.passthrough()` (or include `hitly`) before `verifyHitlyResume`.

