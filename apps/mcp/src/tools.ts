import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_DEADLINE_MS, type McpConfig } from './config.ts'
import { ANSWER_TYPE_ALIASES, FORM_REJECTION_MESSAGE } from './answer-types.ts'
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

/**
 * hitl/v0 typed answer schemas for ask_user (hitl-spec 3.4). The published
 * enum carries the spec names plus the legacy MCP aliases; `simple_form` and
 * `fields[]` are NOT advertised (there are no forms in v0) but still survive
 * parse via `flagFormPayload` + passthrough so the handler can refuse them
 * with the plain-language one-request-per-field message instead of a raw
 * zod parse error.
 */
const answerOptionInput = z.union([
  z.string().min(1).max(200),
  z.object({
    value: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
  }),
])

const answerBoundsInput = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().min(1).max(40).optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  pattern: z.string().min(1).max(256).optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
})

/** Marks a form-shaped payload for the handler without entering the published enum. */
function flagFormPayload(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (record.type === 'simple_form' || 'fields' in record) {
      return { ...record, type: 'text', __form: true }
    }
  }
  return value
}

const askAnswerSchemaInput = z.preprocess(
  flagFormPayload,
  z
    .object({
      type: z.enum(['text', 'single', 'multi', 'number', 'free_text', 'single_choice', 'multi_choice']).describe(
        'One answer type for this request: text | single | multi | number. hitl/v0 is one question per ask_user: no multi-field forms.',
      ),
      options: z
        .array(answerOptionInput)
        .max(20)
        .optional()
        .describe('Required for single/multi. Strings (value = label) or {value, label?, description?}.'),
      bounds: answerBoundsInput.optional().describe('number: min/max/step/unit. text: minLength/maxLength/pattern. multi: minItems/maxItems.'),
    })
    .passthrough(),
)

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
    .describe('ISO 8601 deadline. When omitted the host default rules: the project timeout if set, else 24 hours from now. Expiry never counts as approval.'),
  callback_url: httpsUrl
    .optional()
    .describe(
      'https URL HITLy POSTs the outcome to (HTTP plugin resumeUrl). Treat it as a hint; confirm with get_decision. ' +
        'When omitted HITLy attempts NO callback at all: poll get_decision for the outcome.',
    ),
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

function resolveDeadline(ctx: ToolContext, deadline?: string): { iso?: string } | { error: string } {
  const now = ctx.now?.() ?? Date.now()
  if (!deadline) return { iso: undefined }
  const at = Date.parse(deadline)
  if (Number.isNaN(at)) return { error: 'deadline must be an ISO 8601 date-time' }
  if (at <= now) return { error: 'deadline must be in the future' }
  if (at - now > MAX_DEADLINE_MS) {
    return { error: `deadline must be at most ${MAX_DEADLINE_MS / (24 * 60 * 60 * 1000)} days from now` }
  }
  return { iso: new Date(at).toISOString() }
}

/**
 * The deadline the requester is told about is the one the HOST stored
 * (returned on create and replay alike), never a locally recomputed value:
 * host-side rule/project defaults and the create-once replay must both be
 * visible. Falls back to the local value only on hosts without the field.
 */
function reportedDeadline(
  created: { data: { replayed?: boolean; [key: string]: unknown } },
  fallbackIso?: string,
): string | null {
  const stored = created.data.expiresAt
  if (typeof stored === 'string' && !Number.isNaN(Date.parse(stored))) return stored
  if (fallbackIso) return fallbackIso
  return typeof stored === 'string' ? stored : null
}

/**
 * callback_url is the only source of a resumeUrl. When it is omitted no
 * resumeUrl is sent at all: the HTTP plugin stores nothing and skips
 * resume(), so HITLy attempts NO callback - the bot confirms with
 * get_decision. HITLY_MCP_PUBLIC_URL exists only to allowlist this server's
 * Origin on /mcp; it is never a synthesised callback sink.
 */
function resolveResumeUrl(callbackUrl?: string): { url?: string; callback: boolean } {
  if (callbackUrl) return { url: callbackUrl, callback: true }
  return { url: undefined, callback: false }
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
  // NOTE (soft, deliberately not refactored): beyond the strict hitl/response/v0
  // schema this result also carries host-convenience keys `editedArgs`,
  // `response` and `callbackDelivery`. Requesters treat them as HITLy extras,
  // not schema fields; any future strictness pass should move or version them.
  // PM ruling on hitl-spec 4.2 (Test M1): a typed answer is the ONLY carrier.
  // When the read holds one, the top-level value MUST NOT appear on the
  // get_decision result either, so the whole value mapping is skipped
  // (mirrors buildHitlRead on the REST side).
  const typedAnswer = read.answer !== undefined && read.answer !== null
  if (status === 'answered' && !typedAnswer) {
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
  // Host-reported delivery outcome for requests created without callback_url
  // (no resumeUrl stored, resume skipped): 'none'. A decided request that had
  // a callback carries no callbackDelivery on the read; failed_resume below wins.
  if (typeof read.callbackDelivery === 'string') out.callbackDelivery = read.callbackDelivery
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
      // Every item carries a top-level `requestId` (the handle get_decision
      // and cancel take). Hosts that label the field `id` only are mapped so
      // clients never see requestId missing from a listed item.
      const out: Record<string, unknown> = {
        id: item.id,
        requestId: item.requestId ?? item.id,
        kind: item.kind ?? 'approval',
      }
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
        'Ask a human (on HITLy web or mobile) to Approve, Reject or Ignore an action. Returns immediately with requestId and state "pending"; it never waits. Wait for the callback (only when callback_url was given; without it HITLy makes no callback at all), or poll get_decision politely (30-60s, backing off) until the deadline (default 24h). If get_decision returns editedArgs, act on those, not the original args. Expiry is never approval.',
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
        const resume = resolveResumeUrl(input.callback_url)
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
          ...(resume.url ? { resumeUrl: resume.url } : {}),
          actionName: input.action.name,
          args,
          question: input.question.trim(),
          contextMarkdown: input.context ? `**${input.question.trim()}**\n\n${input.context}` : `**${input.question.trim()}**`,
          allowedActions: { accept: true, reject: true, ignore: true },
          ...(reasonRequired ? { reasonRequired } : {}),
          ...(input.links ? { externalUrls: input.links } : {}),
          // Only an EXPLICIT deadline is sent: with no deadline the host
          // default rules (project timeout, else 24h), so the two sides can
          // never disagree and the caller's default is never clamped.
          ...(deadline.iso ? { expiresAt: deadline.iso } : {}),
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
        'Ask a human a question and get a typed answer later. The prompt is the headline shown to the reviewer: one line, at most 160 characters, ending with "?". Use the optional markdown detail (at most 8000 characters) to explain; it renders under the headline. Returns immediately with requestId and state "pending"; it never waits. Confirm with get_decision before acting; the reviewer\'s typed answer comes back as answer {kind, value} (e.g. {"kind":"single","value":"blue"}) - use it verbatim. Ask one question per request: hitl/v0 answers exactly one ask, so issue one ask_user per field; simple_form is refused with an error - send a separate ask_user for each field.',
      inputSchema: {
        ...common,
        prompt: z.string().describe('Headline question: one sentence, at most 160 characters, ending with "?".'),
        detail: z
          .string()
          .optional()
          .describe(`Optional markdown explanation shown under the headline (at most ${DETAIL_MAX} characters).`),
        answerSchema: askAnswerSchemaInput,
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
        const schema = input.answerSchema as unknown as {
          type: string
          options?: Array<string | { value: string; label?: string; description?: string }>
          bounds?: Record<string, unknown>
          __form?: boolean
        }
        // hitl/v0 is one request per field: a form-shaped payload never reaches the host.
        if (schema.__form) return { result: fail('invalid_request', FORM_REJECTION_MESSAGE) }
        const answerType = ANSWER_TYPE_ALIASES[schema.type]
        if (!answerType) {
          return {
            result: fail(
              'invalid_request',
              'answerSchema.type must be one of: text, single, multi, number (legacy aliases free_text, single_choice, multi_choice are accepted)',
            ),
          }
        }
        const needsOptions = answerType === 'single' || answerType === 'multi'
        if (needsOptions && !schema.options?.length) {
          return { result: fail('invalid_request', `${answerType} needs options`) }
        }
        if (!needsOptions && schema.options?.length) {
          return { result: fail('invalid_request', `${answerType} does not take options`) }
        }
        // Normalise options onto the spec shape {value, label, description?}.
        const options = schema.options?.map((option) => {
          if (typeof option === 'string') return { value: option, label: option }
          const normalised: { value: string; label: string; description?: string } = {
            value: option.value,
            label: option.label?.trim() || option.value,
          }
          if (option.description?.trim()) normalised.description = option.description.trim()
          return normalised
        })
        if (options) {
          const values = options.map((option) => option.value)
          if (new Set(values).size !== values.length) {
            return { result: fail('invalid_request', 'answerSchema.options values must be distinct') }
          }
        }
        if (schema.bounds) {
          if (schema.bounds.step !== undefined && (typeof schema.bounds.step !== 'number' || schema.bounds.step <= 0)) {
            return { result: fail('invalid_request', 'answerSchema.bounds.step must be greater than 0') }
          }
          if (
            typeof schema.bounds.min === 'number' &&
            typeof schema.bounds.max === 'number' &&
            schema.bounds.max < schema.bounds.min
          ) {
            return { result: fail('invalid_request', 'answerSchema.bounds.max must be >= min') }
          }
          if (
            typeof schema.bounds.minItems === 'number' &&
            typeof schema.bounds.maxItems === 'number' &&
            schema.bounds.maxItems < schema.bounds.minItems
          ) {
            return { result: fail('invalid_request', 'answerSchema.bounds.maxItems must be >= minItems') }
          }
        }
        const deadline = resolveDeadline(ctx, input.deadline)
        if ('error' in deadline) return { result: fail('invalid_request', deadline.error) }
        const resume = resolveResumeUrl(input.callback_url)
        const tokenError = checkCbToken(ctx, input.cb_auth_token)
        if (tokenError) return { result: fail('not_supported_by_host', tokenError) }

        const lines = [`**${input.prompt.trim()}**`]
        if (input.detail) lines.push('', input.detail.trim())
        // Option bullets are supporting detail under the headline; the stored
        // answerSchema below is authoritative for what the reviewer answers.
        if (options?.length) lines.push('', ...options.map((option) => `- ${option.label}`))
        if (input.context) lines.push('', input.context)
        // The host persists this schema on the envelope and renders the matching
        // widget (text input, radios, checkboxes, number input); the reviewer's
        // answer comes back as hitl/response/v0 `answer: { kind, value }` with
        // `kind` equal to the stored spec type (#129 / hitl-spec#15).
        const body: Record<string, unknown> = {
          plugin: 'http',
          kind: 'question',
          runId: `mcp-${input.idempotencyKey}`,
          ...(resume.url ? { resumeUrl: resume.url } : {}),
          actionName: 'ask_user',
          args: {},
          prompt: input.prompt.trim(),
          answerSchema: {
            type: answerType,
            ...(options?.length ? { options } : {}),
            ...(schema.bounds ? { bounds: schema.bounds } : {}),
          },
          contextMarkdown: lines.join('\n'),
          allowedActions: { accept: false, reject: false, respond: true, ignore: true },
          // Only an EXPLICIT deadline is sent (see request_approval): no
          // deadline => the host default applies (24h unless the project
          // sets its own timeout).
          ...(deadline.iso ? { expiresAt: deadline.iso } : {}),
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
        'List open requests created with this credential (requestId, kind, question or prompt, createdAt, deadline). Optional cursor pages through the host list; the result includes nextCursor when more items remain.',
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
