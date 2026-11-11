/**
 * Redaction-safe content extraction for the decision-needed email.
 *
 * The email is built ONLY from an explicit allowlist of human-facing fields.
 * Raw envelope/origin bags may contain callback secrets (cb_auth_token),
 * resume handles, payload secrets, tool identifiers and internal URLs — none
 * of those keys are ever read here, and nothing is serialised wholesale, so
 * a secret cannot reach the email by accident.
 */

/** Origin keys that hold human-facing names (mirrors apps/app/lib/origin.ts labels). */
const ASKER_ORIGIN_KEYS = ['agentName', 'workflowName', 'profileName'] as const

/** envelope.metadata keys that hold a display-only action summary. */
const ACTION_SUMMARY_KEYS = ['summary', 'title', 'headline', 'description'] as const

export type DecisionEmailContent = {
  /** Headline question (ask_user prompt), sanitized; null for plain approvals. */
  question: string | null
  /**
   * Human-readable action summary for approval-style requests: the first
   * display-only key of envelope.metadata (`summary`/`title`/`headline`/
   * `description`). Credential-shaped keys are never read.
   */
  actionSummary: string | null
  projectName: string | null
  askedBy: string | null
  /** Readable UTC deadline, e.g. "Friday 14 November 2026 at 09:00 UTC (in about 3 hours)". */
  deadlineLabel: string | null
  subject: string
  /**
   * Push notification title. ask_user: the question itself; request_approval:
   * "HITLy: <action summary>"; fallback: the branded subject. Same
   * trim/truncate rules as the email subject (single helper, so push and
   * email wording always match).
   */
  pushTitle: string
}

/** Collapse whitespace/control chars, cap the length. Never returns markup or newlines. */
export function safeText(value: unknown, maxChars = 200): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned
}

function firstString(bag: Record<string, unknown> | null | undefined, keys: readonly string[]): string | null {
  if (!bag || typeof bag !== 'object') return null
  for (const key of keys) {
    const text = safeText(bag[key], 120)
    if (text) return text
  }
  return null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Readable UTC deadline with a coarse relative hint. `now` is injectable for tests. */
export function deadlineLabel(expiresAt: Date | string | null | undefined, now: Date = new Date()): string | null {
  if (expiresAt === null || expiresAt === undefined) return null
  const at = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null
  const day = `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`
  const hh = String(at.getUTCHours()).padStart(2, '0')
  const mm = String(at.getUTCMinutes()).padStart(2, '0')
  const absolute = `${day} at ${hh}:${mm} UTC`
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return `${absolute} — this request may have expired`
  if (minutes < 60) return `${absolute} (in about ${minutes} min)`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${absolute} (in about ${hours} hour${hours === 1 ? '' : 's'})`
  const days = Math.round(hours / 24)
  return `${absolute} (in about ${days} day${days === 1 ? '' : 's'})`
}

/**
 * Build the reviewer-facing content of a decision email from raw approval
 * data. Only allowlisted fields are read; the raw bags never reach the
 * output. `actionName` is deliberately NOT accepted: raw tool names must not
 * appear in email copy.
 */
export function extractDecisionEmailContent(args: {
  projectName?: string | null
  envelope?: Record<string, unknown> | null
  origin?: Record<string, unknown> | null
  /** Display name of the project API key that created the request, when known. */
  requestedByKey?: string | null
  expiresAt?: Date | string | null
  now?: Date
}): DecisionEmailContent {
  const question = safeText(args.envelope?.prompt, 160)
  const projectName = safeText(args.projectName, 120)
  const askedBy =
    firstString(args.origin, ASKER_ORIGIN_KEYS) ?? safeText(args.requestedByKey, 120)
  const deadline = deadlineLabel(args.expiresAt, args.now)
  const metadata =
    args.envelope?.metadata && typeof args.envelope.metadata === 'object' && !Array.isArray(args.envelope.metadata)
      ? (args.envelope.metadata as Record<string, unknown>)
      : null
  let actionSummary: string | null = null
  if (metadata) {
    for (const key of ACTION_SUMMARY_KEYS) {
      const text = safeText(metadata[key], 160)
      if (text) {
        actionSummary = text
        break
      }
    }
  }
  const subject = question
    ? question.length <= 90
      ? `HITLy: ${question}`
      : projectName
        ? `HITLy: ${projectName} needs your decision`
        : 'HITLy: a decision is waiting for you'
    : projectName
      ? `HITLy: ${projectName} needs your decision`
      : 'HITLy: a decision is waiting for you'
  const pushTitle = question ?? (actionSummary ? `HITLy: ${actionSummary}` : subject)
  return { question, actionSummary, projectName, askedBy, deadlineLabel: deadline, subject, pushTitle }
}
