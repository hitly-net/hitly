# AGENT.md — implement Hitly in an existing project

Use this file when the user asks you to add Hitly human-in-the-loop approvals to an **existing** agent, workflow, or automation project.

Hitly is the reviewer inbox. The origin framework (Mastra, Hermes, HTTP callbacks, LangGraph, Temporal) keeps the pause/resume primitive. You do not rebuild Hitly, and you do not approve inside the origin UI if Hitly should own the decision.

Docs: [hitly.net/docs](https://hitly.net/docs). Runnable Mastra sample: `examples/mastra` in this repo. Hermes drop-in plugin: `examples/hermes`. HTTP recipes: `examples/n8n`, `examples/notion`.

## What you are building

```
origin pauses  →  POST /api/v1/approvals  →  reviewer decides in Hitly  →  plugin resumes origin
```

1. Sensitive work hits a pause point (`suspend()`, wait node, `interrupt()`, etc.).
2. The origin POSTs an envelope to Hitly (`Authorization: Bearer hitly_…`).
3. A human accepts, edits, or rejects in the Hitly inbox.
4. Hitly calls back into the origin. You must handle `approved: true` and `approved: false`.

Do not resume the run yourself after the POST. Hitly does that.

## Before you write code

Confirm all of this exists. If it does not, stop and tell the user what to create.

1. A running Hitly app (self-host `yarn dev:app` on http://localhost:3001, or Cloud at https://app.hitly.net).
2. A **project** whose plugin matches the origin (`mastra`, `hermes`, `http`, `langgraph`, `temporal`).
3. A project API key and `HITLY_PROJECT_ID` (Config tab → Origin `.env`).
4. Origin **base URL** stored on the project (or sent as `mastraBaseUrl` / equivalent on ingest). Hitly must be able to reach that URL to resume. `localhost` only works when Hitly and the origin run on the same machine.

Env the origin process needs:

```bash
HITLY_API_URL=http://localhost:3001
HITLY_API_KEY=hitly_...
HITLY_PROJECT_ID=prj_...
```

Mastra also needs `MASTRA_BASE_URL` (Studio/dev server, default http://localhost:4111).

## Universal recipe

Apply this in any existing codebase:

1. Find the irreversible or gated action (refund, send, delete, deploy).
2. Pause **before** it executes, using that framework’s primitive.
3. POST to `{HITLY_API_URL}/api/v1/approvals` with `plugin`, `projectId`, `runId`, `action`, and enough `resumeHandle` fields for the plugin to resume (see [API](https://hitly.net/docs/api) and [envelope](https://hitly.net/docs/envelope)).
4. On resume, branch on the decision. Mastra maps:

   | Hitly decision | Resume payload |
   | --- | --- |
   | accept | `{ approved: true }` |
   | edit | `{ approved: true, ...editedArgs }` |
   | reject | `{ approved: false }` |
   | respond | `{ approved: true, response }` |
   | ignore | no resume |

   HTTP / n8n resume is `{ decision, id, metadata }` (not `{ approved }`). See [API](https://hitly.net/docs/api).
5. Persist run snapshots so a pause survives process restart (Mastra: storage on the `Mastra` instance).
6. Keep origin credentials on the Hitly project. Do not put Hitly secrets in git.

Prefer `@hitly/plugin-*` helpers (`notifyHitlyApproval` for Mastra; copy `examples/hermes` for Hermes Agent) when the package is available. Until npm publish, copy the helper from `packages/plugin-mastra/src/index.ts` or POST the JSON yourself.

## Mastra

Install `@hitly/plugin-mastra` when you can. Copy `notifyHitlyApproval` from this repo if you cannot.

**Do not** set `requireApproval: true` on a tool you want Hitly to see. That flag pauses *before* `execute`, so Hitly is never notified. Suspend inside `execute` after `notifyHitlyApproval()`.

Agent HITL needs a storage adapter (for example LibSQL `file:./mastra.db`) on `new Mastra({ storage })`.

### Workflow step

Put this in an existing workflow. Notify Hitly, then `suspend()`. On reject, `bail()` so later steps do not run.

```ts
import { createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { notifyHitlyApproval } from '@hitly/plugin-mastra'

const approval = createStep({
  id: 'hitly-approval',
  inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
  outputSchema: z.object({ orderId: z.string(), amount: z.number(), approved: z.literal(true) }),
  resumeSchema: z.object({ approved: z.boolean(), orderId: z.string().optional(), amount: z.number().optional() }),
  suspendSchema: z.object({ reason: z.string() }),
  execute: async ({ inputData, resumeData, suspend, bail, runId }) => {
    const orderId = resumeData?.orderId ?? inputData.orderId
    const amount = resumeData?.amount ?? inputData.amount

    if (resumeData?.approved === false) {
      return bail({ reason: 'Reviewer rejected the refund.' })
    }

    if (!resumeData?.approved) {
      await notifyHitlyApproval(
        {
          apiUrl: process.env.HITLY_API_URL!,
          apiKey: process.env.HITLY_API_KEY!,
          projectId: process.env.HITLY_PROJECT_ID!,
          mastraBaseUrl: process.env.MASTRA_BASE_URL,
          kind: 'workflow',
          workflowId: 'refund-workflow', // must match createWorkflow({ id })
          stepId: 'hitly-approval',
          action: { name: 'send-refund', args: { orderId, amount } },
        },
        {
          runId,
          suspendPayload: { reason: `Refund ${amount} for order ${orderId}` },
        },
      )
      return await suspend({ reason: 'Human approval required in Hitly.' })
    }

    return { orderId, amount, approved: true as const }
  },
})
```

Wire it with `.then(approval).then(issueRefund).commit()`. Hitly resumes via `POST {MASTRA_BASE_URL}/api/workflows/{workflowId}/resume?runId=…`.

### Agent tool

Same notify-then-suspend pattern. `runId` is on the tool context at runtime even if the public type omits it. On reject, return a failure result to the model (tools have no `bail()`).

```ts
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { notifyHitlyApproval } from '@hitly/plugin-mastra'

export const sendRefundTool = createTool({
  id: 'send-refund',
  description: 'Issue a refund after a Hitly reviewer approves.',
  inputSchema: z.object({
    orderId: z.string().describe('Order to refund'),
    amount: z.number().describe('Refund amount'),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    orderId: z.string(),
    amount: z.number(),
    message: z.string(),
  }),
  resumeSchema: z.object({ approved: z.boolean(), orderId: z.string().optional(), amount: z.number().optional() }),
  suspendSchema: z.object({ reason: z.string() }),
  execute: async (inputData, context) => {
    const runId = (context as { runId?: string }).runId
    const resumeData = context.agent?.resumeData as { approved?: boolean; orderId?: string; amount?: number } | undefined
    const orderId = resumeData?.orderId ?? inputData.orderId
    const amount = resumeData?.amount ?? inputData.amount

    if (resumeData?.approved === false) {
      return { sent: false, orderId, amount, message: 'Reviewer rejected the refund.' }
    }

    if (!resumeData?.approved) {
      if (!runId) throw new Error('Mastra tool context is missing runId')
      await notifyHitlyApproval(
        {
          apiUrl: process.env.HITLY_API_URL!,
          apiKey: process.env.HITLY_API_KEY!,
          projectId: process.env.HITLY_PROJECT_ID!,
          mastraBaseUrl: process.env.MASTRA_BASE_URL,
          kind: 'agent',
          agentId: 'refund-agent', // must match Agent({ id })
          toolCallId: context.agent?.toolCallId,
          action: { name: 'send-refund', args: { orderId, amount } },
        },
        { runId, suspendPayload: { reason: `Refund ${amount} for order ${orderId}` } },
      )
      if (!context.agent?.suspend) throw new Error('Mastra tool context is missing suspend()')
      return await context.agent.suspend({ reason: 'Human approval required in Hitly.' })
    }

    return { sent: true, orderId, amount, message: `Refund of ${amount} issued for order ${orderId}.` }
  },
})
```

Hitly resumes via `POST {MASTRA_BASE_URL}/api/agents/{agentId}/resume-stream` with `{ runId, toolCallId, resumeData }`.

Full wiring (storage, Studio, local model): `examples/mastra`. Integration notes: `apps/web/content/integrations/mastra.mdx`.

### Mastra checklist

- [ ] `HITLY_*` and `MASTRA_BASE_URL` are set in the Mastra process env.
- [ ] Hitly project plugin is `mastra`; origin base URL is the Mastra server Hitly can reach.
- [ ] `new Mastra({ storage })` is configured so suspend snapshots persist.
- [ ] Workflow `id` / agent `id` passed to `notifyHitlyApproval` match the registered ids.
- [ ] Tool/step calls `notifyHitlyApproval` **then** `suspend()` (not `requireApproval: true`).
- [ ] Reject path: workflow `bail()`, agent tool returns `sent: false` (or equivalent).
- [ ] Sensitive side effect runs only after `resumeData.approved === true`.

## Other origins (short)

| Origin | Pause | What to send Hitly | Resume (plugin) |
| --- | --- | --- | --- |
| HTTP | caller `resumeUrl` | `resumeUrl`, `projectId`, action, optional `metadata` | POST `{ decision, id, metadata }` to `resumeUrl` |
| n8n | Wait node (webhook) | same as HTTP; `resumeUrl` is `$execution.resumeUrl`; create an **HTTP** project | POST `{ decision, id, metadata }` to `$execution.resumeUrl` |
| Hermes | approval transport / `kanban_block` | command or `taskId` + `kind: kanban` | origin polls GET `/api/v1/approvals/:id`; kanban comment + unblock |
| LangGraph | `interrupt()` | thread/run ids | `HumanResponse` |
| Temporal | `condition()` + signal | workflow id / run id | signal `hitly.decision` |

Guides: `apps/web/content/integrations/`. Plugins: `packages/plugin-*`.

## Verify

1. Trigger the pause (Studio chat, workflow run, HTTP callback, n8n execution, …).
2. Confirm a pending item in Hitly inbox (`{HITLY_API_URL}/inbox`).
3. Accept: origin continues and the side effect runs.
4. Reject: origin does **not** run the side effect (`bail()` / rejection result).
5. If resume fails, Hitly status is `failed_resume`; fix reachability/`mastraBaseUrl`, then retry resume from the approval. If the origin is no longer suspended, **Force cancel** the item.

## Do not

- Approve only in Mastra Studio if the user asked for Hitly.
- Call the irreversible action before `resumeData.approved === true`.
- Point a hosted Hitly workspace at `http://localhost:…`.
- Invent a second approval inbox in the origin app.
- Commit `.env` files or API keys.
