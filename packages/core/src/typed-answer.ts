/**
 * Typed reviewer answers (ask_user).
 *
 * A decide/answer submission may carry an `answer` beside the binary decision:
 * the reviewer's typed response to the agent's ask_user question. It is a small
 * discriminated bag `{ kind, value }` (e.g. `{ kind: 'single_choice', value: 'blue' }`).
 *
 * The host carries it verbatim into the decision payload and the origin callback
 * (it must NEVER be silently dropped — spec 7: refuse malformed values rather
 * than degrade them), so parseDecisionBody validates the shape BEFORE storage:
 * a present-but-malformed answer is a 400, not a quietly stripped field.
 */

export interface TypedAnswer {
  /** Answer kind, e.g. `single_choice`, `multi_choice`, `free_text`, `confirm`. */
  kind: string
  /** The reviewer's value. Any JSON-representable value (string, number, bool, array, object). */
  value: unknown
}

/** True for a plain object (not array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** True when the value survives a JSON round-trip (no functions, NaN/Infinity, bigint, cycles). */
function isJsonRepresentable(value: unknown): boolean {
  if (typeof value === 'number' && !Number.isFinite(value)) return false
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') return false
  try {
    return JSON.stringify({ v: value }) !== undefined
  } catch {
    return false
  }
}

/**
 * Validate one submitted `answer`. Returns a human-readable reason when the value
 * is present but malformed, or `null` when valid (including `undefined` = absent).
 */
export function validateTypedAnswer(answer: unknown): string | null {
  if (answer === undefined) return null
  if (!isPlainObject(answer)) {
    return 'answer must be an object with a non-empty string "kind" and a "value"'
  }
  const kind = answer.kind
  if (typeof kind !== 'string' || !kind.trim()) {
    return 'answer.kind must be a non-empty string'
  }
  if (!('value' in answer) || answer.value === undefined) {
    return 'answer.value is required'
  }
  if (!isJsonRepresentable(answer.value)) {
    return 'answer.value must be JSON-representable'
  }
  return null
}

/** Type-guard convenience for a valid typed answer (undefined rejected). */
export function isTypedAnswer(answer: unknown): answer is TypedAnswer {
  return answer !== undefined && validateTypedAnswer(answer) === null
}
