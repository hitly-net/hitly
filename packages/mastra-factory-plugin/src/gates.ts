import { randomBytes } from 'node:crypto'
import type { ApprovalRequest, Gate, GateSession, PluginRuntimeConfig } from './types.ts'

export const GATE_METADATA_KEY = 'net.hitly/gate'
// `/api` is reserved by @mastra/server (1.85+) — a plugin route mounted
// there crashes the host server at startup. `/custom` is the open namespace.
export const RESUME_PATH = '/custom/integrations/hitly/resume'

export const METADATA_KEYS = {
  gate: 'net.hitly/gate',
  sessionId: 'net.hitly/factory/session-id',
  threadId: 'net.hitly/factory/thread-id',
  projectId: 'net.hitly/factory/project-id',
  toolCallId: 'net.hitly/factory/tool-call-id',
  orgId: 'net.hitly/factory/org-id',
  userId: 'net.hitly/factory/user-id',
  headSha: 'net.hitly/factory/head-sha',
  prUrl: 'net.hitly/factory/pr-url',
} as const

/** Closed set: the only Factory tool calls that open HITLy gates. */
const GATE_TOOLS: Record<string, Gate> = {
  submit_plan: 'plan',
  factory_record_review_verdict: 'review',
  ask_user: 'ask_user',
}

const ALLOWED_ACTIONS: Record<Gate, NonNullable<ApprovalRequest['allowedActions']>> = {
  plan: { accept: true, reject: true, edit: true, respond: false },
  review: { accept: true, reject: true, edit: false, respond: false },
  ask_user: { accept: false, reject: true, edit: false, respond: true },
}

const ACTION_NAMES: Record<Gate, string> = {
  plan: 'mastra-factory/plan',
  review: 'mastra-factory/review',
  ask_user: 'mastra-factory/ask_user',
}

export interface HitlyClientLike {
  createApproval(body: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string; status: string }>
}

export function detectGate(toolName: string, gates: Record<Gate, boolean>): Gate | null {
  const gate = GATE_TOOLS[toolName]
  if (!gate) return null
  return gates[gate] ? gate : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function planBodyText(input: unknown): string {
  const record = asRecord(input)
  return (
    textOf(record.content) ??
    textOf(record.plan) ??
    (record.path ? `(plan file: ${String(record.path)})` : JSON.stringify(record, null, 2))
  )
}

function reviewTexts(input: unknown): { verdict?: string; body?: string } {
  const record = asRecord(input)
  return { verdict: textOf(record.verdict), body: textOf(record.body) }
}

function askUserTexts(input: unknown): { question?: string; options?: string } {
  const record = asRecord(input)
  const options = Array.isArray(record.options)
    ? (record.options as unknown[])
        .map((option) => {
          if (typeof option === 'string') return option
          const label = asRecord(option).label
          return typeof label === 'string' ? label : undefined
        })
        .filter((value): value is string => Boolean(value))
    : []
  return {
    question: textOf(record.question),
    options: options.length > 0 ? options.map((option) => `- ${option}`).join('\n') : undefined,
  }
}

function contextMarkdown(
  gate: Gate,
  session: GateSession,
  input: unknown,
  pr?: { url: string; headSha?: string },
): string {
  const lines: string[] = []
  lines.push(`Mastra Factory session \`${session.sessionId}\``)
  if (session.factoryProjectId) lines.push(`Factory project \`${session.factoryProjectId}\``)
  if (pr) {
    lines.push(`Pull request: ${pr.url}${pr.headSha ? ` (head \`${pr.headSha}\`)` : ''}`)
  }
  lines.push('')
  if (gate === 'plan') {
    lines.push('## Proposed plan', '', planBodyText(input))
  } else if (gate === 'review') {
    const { verdict, body } = reviewTexts(input)
    lines.push('## Review verdict')
    if (verdict) lines.push('', `Verdict: ${verdict}`)
    if (body) lines.push('', body)
  } else {
    const { question, options } = askUserTexts(input)
    lines.push('## Question')
    if (question) lines.push('', question)
    if (options) lines.push('', 'Options:', options)
  }
  return lines.join('\n')
}

export function buildApprovalRequest(args: {
  gate: Gate
  toolCallId: string
  session: GateSession
  input: unknown
  output: unknown
  pr?: { url: string; headSha?: string }
  config: PluginRuntimeConfig
}): ApprovalRequest {
  const { gate, toolCallId, session, input, output, pr, config } = args
  const metadata: Record<string, string> = {
    [METADATA_KEYS.gate]: gate,
    [METADATA_KEYS.sessionId]: session.sessionId,
    [METADATA_KEYS.toolCallId]: toolCallId,
  }
  if (session.threadId) metadata[METADATA_KEYS.threadId] = session.threadId
  if (session.factoryProjectId) metadata[METADATA_KEYS.projectId] = session.factoryProjectId
  if (session.orgId) metadata[METADATA_KEYS.orgId] = session.orgId
  if (session.userId) metadata[METADATA_KEYS.userId] = session.userId
  if (pr?.url) metadata[METADATA_KEYS.prUrl] = pr.url
  if (pr?.headSha) metadata[METADATA_KEYS.headSha] = pr.headSha

  const review = gate === 'review' ? asRecord(output) : {}
  if (typeof review.headSha === 'string' && !(METADATA_KEYS.headSha in metadata)) {
    metadata[METADATA_KEYS.headSha] = review.headSha
  }
  if (typeof review.prUrl === 'string' && !(METADATA_KEYS.prUrl in metadata)) {
    metadata[METADATA_KEYS.prUrl] = review.prUrl
  }

  const request: ApprovalRequest = {
    plugin: 'mastra-factory',
    runId: `factory:${session.sessionId}:${toolCallId}`,
    actionName: ACTION_NAMES[gate],
    contextMarkdown: contextMarkdown(gate, session, input, pr),
    resumeUrl: `${config.publicBaseUrl}${RESUME_PATH}`,
    idempotencyKey: `hitly-mf:${session.sessionId}:${toolCallId}`,
    metadata,
    allowedActions: ALLOWED_ACTIONS[gate],
    // Per-request callback bearer: HITLy echoes this back as
    // `Authorization: Bearer <token>` on resume callbacks (plugin-http
    // stores it on the resume handle and never echoes it elsewhere), so the
    // route can bind each callback to the approval that requested it.
    cbAuthToken: randomBytes(32).toString('hex'),
  }
  // plugin-http validates reasonRequired as an array of non-empty answer
  // values — a boolean `true` is rejected with 400 at ingest.
  if (gate === 'plan' || gate === 'review') request.reasonRequired = ['reject']
  if (gate === 'ask_user') {
    const { question } = askUserTexts(input)
    if (question) {
      request.question = question
      request.prompt = question
    }
  }
  return request
}
