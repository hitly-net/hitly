import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, type McpConfig } from './config.ts'
import type { ApprovalRead, HostClient, HostResult } from './host-client.ts'
import { argsHash } from './jcs.ts'
import type { Logger } from './logger.ts'

/**
 * The requester surface. There is deliberately no decide/approve/answer tool:
 * requester credentials can request, read and cancel only. Decisions come from a
 * signed-in human on HITLy web or mobile.
 */
export const TOOL_NAMES = ['request_approval', 'ask_user', 'get_decision', 'list_pending', 'cancel'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export interface ToolContext {
  config: McpConfig
  host: HostClient
  logger: Logger
  clientId: string
  now?: () => number
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}

function fail(code: string, message: string): ToolResult {
  const data = { error: { code, message } }
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true }
}

function hostFail(result: Extract<HostResult<unknown>, { ok: false }>, hint?: string): ToolResult {
  return fail(result.code, hint ? `${result.error} (${hint})` : result.error)
}

const httpsUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('https://'), 'must be an https URL')

const link = z.object({
  url: httpsUrl,
  label: z.string().max(200).optional(),
  mustOpen: z.boolean().optional(),
})

const common = {
  idempotencyKey: z
    .string()
    .min(8)
    .max(200)
    .regex(/^[\x21-\x7e]+$/, 'printable ASCII, no spaces')
    .describe('Stable key for this ask (e.g. hash of bot id, task id, action name and argsHash). Retries return the same request.'),
  context: z.string().max(64_000).optional().describe('Markdown detail shown to the reviewer.'),
  deadline: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe('ISO 8601 deadline. Default: 24 hours from now. Expiry never counts as approval.'),
  callback_url: httpsUrl
    .optional()
    .describe('https URL HITLy POSTs the outcome to (HTTP plugin resumeUrl). Treat it as a hint; confirm with get_decision.'),
  cb_auth_token: z
    .string()
    .min(16)
    .max(512)
    .optional()
    .describe('Bearer token HITLy sends on callbacks. Never echoed back.'),
}

export const QUESTION_MAX = 160

export function validateQuestion(question: string): string | null {
  const trimmed = question.trim()
  if (!trimmed) return 'question is required'
  if (trimmed.length > QUESTION_MAX) return `question must be at most ${QUESTION_MAX} characters`
  if (/[\r\n]/.test(trimmed)) return 'question must be one sentence on one line'
  if (!trimmed.endsWith('?')) return 'question must end with "?"'
  return null
}

/** Optional markdown explanation for ask_user, shown under the headline. Never logged. */
export const DETAIL_MAX = 8_000

export function validateDetail(detail: string): string | null {
  if (!detail.trim()) return 'detail must not be blank; omit it if you have nothing to add'
  if (detail.length > DETAIL_MAX) return `detail must be at most ${DETAIL_MAX} characters`
  return null
}

/** Request ids are opaque host ids (e.g. `apr_0001`); never a path segment. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function validateRequestId(requestId: string): string | null {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return 'requestId must match [A-Za-z0-9_-]{1,64} (no ".", "..", "/" or whitespace)'
  }
  return null
}

function resolveDeadline(ctx: ToolContext, deadline?: string): { iso: string } | { error: string } {
  const now = ctx.now?.() ?? Date.now()
  if (!deadline) return { iso: new Date(now + DEFAULT_DEADLINE_MS).toISOString() }
  const at = Date.parse(deadline)
  if (Number.isNaN(at)) return { error: 'deadline must be an ISO 8601 date-time' }
  if (at <= now) return { error: 'deadline must be in the future' }
  if (at - now > MAX_DEADLINE_MS) {
    return { error: `deadline must be at most ${MAX_DEADLINE_MS / (24 * 60 * 60 * 1000)} days from now` }
  }
  return { iso: new Date(at).toISOString() }
}

/**
 * A replay reports the deadline stored on create, not one recomputed now: the retry
 * may land hours after the original, and the host never moved the real expiry.
 */
function reportedDeadline(created: { data: { replayed?: boolean; [key: string]: unknown } }, fallbackIso: string): string {
  if (created.data.replayed === true && typeof created.data.expiresAt === 'string' && !Number.isNaN(Date.parse(created.data.expiresAt))) {
    return created.data.expiresAt
  }
  return fallbackIso
}

function resolveResumeUrl(ctx: ToolContext, callbackUrl?: string): { url: string; callback: boolean } | { error: string } {
  if (callbackUrl) return { url: callbackUrl, callback: true }
  if (ctx.config.publicUrl) return { url: `${ctx.config.publicUrl}/callbacks/noop`, callback: false }
  return { error: 'callback_url is required on this server (HTTP ingest needs a resumeUrl)' }
}

function checkCbToken(ctx: ToolContext, token?: string): string | null {
  if (token === undefined) return null
  if (!ctx.config.capabilities.has('cb_auth_token')) {
    return 'cb_auth_token is not supported by this HITLy host yet; omit it and confirm callbacks with get_decision'
  }
  return null
}

function reviewUrl(ctx: ToolContext, id: string) {
  return `${ctx.config.appUrl}/inbox/${encodeURIComponent(id)}`
}

async function timed(ctx: ToolContext, tool: ToolName, run: () => Promise<{ result: ToolResult; requestId?: string; status?: string }>) {
  const started = Date.now()
  try {
    const { result, requestId, status } = await run()
    ctx.logger.log({
      event: 'tool',
      tool,
      requestId,
      status: status ?? (result.isError ? 'error' : 'ok'),
      latencyMs: Date.now() - started,
      clientId: ctx.clientId,
    })
    return result
  } catch {
    // Scrubbed: the error itself may contain payload; log only that it failed.
    ctx.logger.log({ event: 'tool', tool, status: 'exception', latencyMs: Date.now() - started, clientId: ctx.clientId })
    return fail('internal_error', 'HITLy MCP server error')
  }
}

const STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  failed_resume: 'answered',
  decided: 'answered',
  expired: 'expired',
  cancelled: 'cancelled',
}

/**
 * Map the host read onto hitl/response/v0. Today's API-key read carries only
 * id, status, decision, response and presentedAt; fields M0 adds (reason, decidedBy,
 * decidedAt, argsHash, editedArgs, answer, activity) are passed through when present.
 */
export function toResponseV0(read: ApprovalRead): Record<string, unknown> {
  const decision = typeof read.decision === 'string' ? read.decision : undefined
  let status = STATUS_MAP[read.status] ?? read.status
  if (read.status === 'decided' || read.status === 'failed_resume') {
    if (decision === 'ignore') status = 'declined'
    if (decision === 'cancel') status = 'cancelled'
  }
  // M0 host reads already speak hitl/response/v0: trust their status.
  if (read.spec === 'hitl/response/v0') status = read.status
  const out: Record<string, unknown> = { spec: 'hitl/response/v0', requestId: read.id, status }
  if (status === 'answered') {
    if (typeof read.value === 'string' || (read.value && typeof read.value === 'object')) out.value = read.value
    else if (decision === 'accept' || decision === 'edit') out.value = 'approve'
    else if (decision === 'reject') out.value = 'reject'
    else if (decision === 'respond' && typeof read.response === 'string') out.value = read.response
  }
  if (typeof read.response === 'string') out.response = read.response
  for (const key of ['reason', 'decidedBy', 'decidedAt', 'argsHash', 'answer'] as const) {
    if (read[key] !== undefined && read[key] !== null) out[key] = read[key]
  }
  const edited = read.editedArgs
  const hasEdited = Boolean(edited && typeof edited === 'object' && !Array.isArray(edited) && Object.keys(edited).length > 0)
  if (hasEdited) {
    // Human amendment. The stored request (and argsHash) is unchanged; the bot must act on these.
    out.editedArgs = edited
  }
  if (decision === 'edit' && !hasEdited) {
    // Fail closed: an 'edit' that lost its editedArgs is corrupt, never an approval.
    out.status = 'declined'
    delete out.value
  }
  const activity = read.activity && typeof read.activity === 'object' ? (read.activity as Record<string, unknown>) : undefined
  out.activity = activity ?? { presentedAt: read.presentedAt ?? null, items: [] }
  if (read.status === 'failed_resume') out.callbackDelivery = 'failed'
  return out
}

function normaliseList(data: unknown): Record<string, unknown>[] {
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? ((data as Record<string, unknown>).items ?? (data as Record<string, unknown>).approvals ?? (data as Record<string, unknown>).requests)
      : undefined
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => {
      const out: Record<string, unknown> = { id: item.id, kind: item.kind ?? 'approval' }
      for (const key of ['question', 'prompt', 'createdAt', 'deadline', 'expiresAt', 'status'] as const) {
        if (item[key] !== undefined) out[key] = item[key]
      }
      return out
    })
}

export function registerTools(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    'request_approval',
    {
      title: 'Request approval',
      description:
        'Ask a human (on HITLy web or mobile) to Approve, Reject or Ignore an action. Returns immediately with requestId and state "pending"; it never waits. Pass callback_url (https) and optionally cb_auth_token to be POSTed when the human decides; the callback is only a hint - confirm with get_decision. With no callback_url there is no callback: poll get_decision politely (30-60s, backing off) until the deadline (default 24h). If get_decision returns editedArgs, act on those, not the original args. Expiry is never approval.',
      inputSchema: {
        ...common,
        question: z.string().describe('One sentence, at most 160 characters, ending with "?".'),
        action: z.object({
          name: z.string().min(1).max(200),
          args: z.record(z.string(), z.unknown()).default({}),
        }),
        risk: z.enum(['low', 'medium', 'high']).optional(),
        reasonRequired: z.array(z.enum(['approve', 'reject', 'ignore'])).optional(),
        links: z.array(link).max(20).optional().describe('https links for the reviewer; mustOpen gates Approve/Reject. HITLy never fetches them.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      timed(ctx, 'request_approval', async () => {
        const questionError = validateQuestion(input.question)
        if (questionError) return { result: fail('invalid_request', questionError) }
        const deadline = resolveDeadline(ctx, input.deadline)
        if ('error' in deadline) return { result: fail('invalid_request', deadline.error) }
        const resume = resolveResumeUrl(ctx, input.callback_url)
        if ('error' in resume) return { result: fail('invalid_request', resume.error) }
        const tokenError = checkCbToken(ctx, input.cb_auth_token)
        if (tokenError) return { result: fail('not_supported_by_host', tokenError) }

        const args = input.action.args ?? {}
        const hash = argsHash(args)
        // hitl-spec 3.6 values → host decision names.
        const reasonRequired = input.reasonRequired?.map((value) => (value === 'approve' ? 'accept' : value))
        const body: Record<string, unknown> = {
          plugin: 'http',
          kind: 'approval',
          runId: `mcp-${input.idempotencyKey}`,
          resumeUrl: resume.url,
          actionName: input.action.name,
          args,
          question: input.question.trim(),
          contextMarkdown: input.context ? `**${input.question.trim()}**\n\n${input.context}` : `**${input.question.trim()}**`,
          allowedActions: { accept: true, reject: true, ignore: true },
          ...(reasonRequired ? { reasonRequired } : {}),
          ...(input.links ? { externalUrls: input.links } : {}),
          expiresAt: deadline.iso,
          argsHash: hash,
          metadata: { source: 'hitly-mcp', ...(input.risk ? { risk: input.risk } : {}) },
          ...(input.cb_auth_token ? { cbAuthToken: input.cb_auth_token } : {}),
        }
        const created = await ctx.host.ingest(body, input.idempotencyKey)
        if (!created.ok) return { result: hostFail(created), status: created.code }
        const id = created.data.id
        return {
          requestId: id,
          status: 'pending',
          result: ok({
            requestId: id,
            state: 'pending',
            replayed: created.data.replayed === true,
            argsHash: hash,
            deadline: reportedDeadline(created, deadline.iso),
            callback: resume.callback,
            reviewUrl: reviewUrl(ctx, id),
          }),
        }
      }),
  )

  server.registerTool(
    'ask_user',
    {
      title: 'Ask the user',
      description:
        'Ask a human a question and get a typed answer later. The prompt is the headline shown to the reviewer: one line, at most 160 characters, ending with "?". Use the optional markdown detail (at most 8000 characters) to explain; it renders under the headline. Returns immediately with requestId and state "pending"; it never waits. Confirm with get_decision before acting; the reviewer\'s typed answer comes back as answer {kind, value} (e.g. {"kind":"single_choice","value":"blue"}) - use it verbatim. Ask one question per request: hitl/v0 answers exactly one ask, so issue one ask_user per field; do not build on simple_form, which is going away.',
      inputSchema: {
        ...common,
        prompt: z.string().describe('Headline question: one sentence, at most 160 characters, ending with "?".'),
        detail: z
          .string()
          .optional()
          .describe(`Optional markdown explanation shown under the headline (at most ${DETAIL_MAX} characters).`),
        answerSchema: z.object({
          type: z.enum(['free_text', 'single_choice', 'multi_choice', 'simple_form']),
          options: z.array(z.string().min(1).max(200)).max(20).optional(),
          fields: z
            .array(z.object({ name: z.string().min(1).max(100), label: z.string().max(200).optional(), required: z.boolean().optional() }))
            .max(20)
            .optional(),
        }),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      timed(ctx, 'ask_user', async () => {
        const promptError = validateQuestion(input.prompt)
        if (promptError) return { result: fail('invalid_request', promptError) }
        if (input.detail !== undefined) {
          const detailError = validateDetail(input.detail)
          if (detailError) return { result: fail('invalid_request', detailError) }
        }
        const schema = input.answerSchema
        if ((schema.type === 'single_choice' || schema.type === 'multi_choice') && !schema.options?.length) {
          return { result: fail('invalid_request', `${schema.type} needs options`) }
        }
        if (schema.type === 'simple_form' && !schema.fields?.length) {
          return { result: fail('invalid_request', 'simple_form needs fields') }
        }
        const deadline = resolveDeadline(ctx, input.deadline)
        if ('error' in deadline) return { result: fail('invalid_request', deadline.error) }
        const resume = resolveResumeUrl(ctx, input.callback_url)
        if ('error' in resume) return { result: fail('invalid_request', resume.error) }
        const tokenError = checkCbToken(ctx, input.cb_auth_token)
        if (tokenError) return { result: fail('not_supported_by_host', tokenError) }

        const lines = [`**${input.prompt.trim()}**`]
        if (input.detail) lines.push('', input.detail.trim())
        if (schema.options?.length) lines.push('', ...schema.options.map((option) => `- ${option}`))
        if (schema.fields?.length) lines.push('', ...schema.fields.map((field) => `- ${field.label ?? field.name}`))
        if (input.context) lines.push('', input.context)
        // Until the question kind lands (M1b) the host stores this as an HTTP approval
        // whose only acting answer is a free-text response.
        const body: Record<string, unknown> = {
          plugin: 'http',
          kind: 'question',
          runId: `mcp-${input.idempotencyKey}`,
          resumeUrl: resume.url,
          actionName: 'ask_user',
          args: {},
          prompt: input.prompt.trim(),
          answerSchema: schema,
          contextMarkdown: lines.join('\n'),
          allowedActions: { accept: false, reject: false, respond: true, ignore: true },
          expiresAt: deadline.iso,
          metadata: { source: 'hitly-mcp', kind: 'question' },
          ...(input.cb_auth_token ? { cbAuthToken: input.cb_auth_token } : {}),
        }
        const created = await ctx.host.ingest(body, input.idempotencyKey)
        if (!created.ok) return { result: hostFail(created), status: created.code }
        const id = created.data.id
        return {
          requestId: id,
          status: 'pending',
          result: ok({
            requestId: id,
            state: 'pending',
            replayed: created.data.replayed === true,
            deadline: reportedDeadline(created, deadline.iso),
            callback: resume.callback,
            reviewUrl: reviewUrl(ctx, id),
          }),
        }
      }),
  )

  server.registerTool(
    'get_decision',
    {
      title: 'Get decision',
      description:
        'Non-blocking read of a request as hitl/response/v0 (status pending | answered | declined | cancelled | expired). If editedArgs is present the human amended the action: use editedArgs, not the original args. If answer is present it is the reviewer\'s typed ask_user answer exactly as the host stored it ({kind, value}): use it verbatim. Poll politely (30-60s, backing off).',
      inputSchema: { requestId: z.string().min(1).max(64) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      timed(ctx, 'get_decision', async () => {
        const idError = validateRequestId(input.requestId)
        if (idError) return { result: fail('invalid_request', idError) }
        const read = await ctx.host.getApproval(input.requestId)
        if (!read.ok) return { requestId: input.requestId, result: hostFail(read), status: read.code }
        const response = toResponseV0(read.data)
        return { requestId: input.requestId, status: String(response.status), result: ok(response) }
      }),
  )

  server.registerTool(
    'list_pending',
    {
      title: 'List pending requests',
      description:
        'List open requests created with this credential (id, kind, question or prompt, createdAt, deadline). Optional cursor pages through the host list; the result includes nextCursor when more items remain.',
      inputSchema: {
        projectId: z.string().min(1).max(64).optional(),
        cursor: z.string().min(1).max(512).optional().describe('Opaque nextCursor from a previous list_pending page.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      timed(ctx, 'list_pending', async () => {
        const listed = await ctx.host.listPending(input.projectId, input.cursor)
        if (!listed.ok) {
          if (listed.code === 'not_supported_by_host') {
            return { result: fail('not_supported_by_host', 'This HITLy host has no key-scoped pending list yet'), status: listed.code }
          }
          return { result: hostFail(listed), status: listed.code }
        }
        const items = normaliseList(listed.data)
        const rawCursor =
          listed.data && typeof listed.data === 'object' && !Array.isArray(listed.data)
            ? (listed.data as { nextCursor?: unknown }).nextCursor
            : undefined
        const nextCursor = typeof rawCursor === 'string' && rawCursor ? rawCursor : null
        return { status: 'ok', result: ok({ items, nextCursor }) }
      }),
  )

  server.registerTool(
    'cancel',
    {
      title: 'Cancel request',
      description: 'Withdraw an open request this credential created. Cancelled is never approval.',
      inputSchema: { requestId: z.string().min(1).max(64), reason: z.string().max(500).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      timed(ctx, 'cancel', async () => {
        const idError = validateRequestId(input.requestId)
        if (idError) return { result: fail('invalid_request', idError) }
        const cancelled = await ctx.host.cancel(input.requestId, input.reason)
        if (!cancelled.ok) {
          const hint = cancelled.code === 'unauthorized' ? 'requester cancel with an API key may not be available on this host yet' : undefined
          return { requestId: input.requestId, result: hostFail(cancelled, hint), status: cancelled.code }
        }
        return { requestId: input.requestId, status: 'cancelled', result: ok({ requestId: input.requestId, state: 'cancelled' }) }
      }),
  )
}
