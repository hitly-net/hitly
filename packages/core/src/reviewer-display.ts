/**
 * Reviewer-facing display helpers for decided ask_user items (inbox detail).
 *
 * Pure functions only: web and mobile share the same answer formatting, empty
 * payload hiding, and title choice. Unknown/legacy shapes fall back to a
 * readable JSON render and never throw.
 */

import { ANSWER_TYPE_ALIASES, type AnswerSchema, type AnswerSchemaType } from './answer-schema.ts'

export type FormattedAnswer =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'json'; text: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === 'string' ? text : String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return '[unprintable]'
    }
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (value === null) return 'null'
  if (value === undefined) return ''
  return safeJson(value)
}

function optionLabel(schema: AnswerSchema | null | undefined, value: unknown): string {
  const raw = typeof value === 'string' ? value : asText(value)
  const options = schema?.options
  if (!options) return raw
  const match = options.find((option) => option.value === raw)
  const label = match?.label?.trim()
  return label || raw
}

function schemaTypeOf(
  schema: AnswerSchema | null | undefined,
  kind: string | undefined,
): AnswerSchemaType | undefined {
  if (schema?.type) return schema.type
  if (!kind) return undefined
  return ANSWER_TYPE_ALIASES[kind]
}

/**
 * Pull the typed `{kind, value}` answer out of a decision payload (or a
 * top-level `answer` field). Absent and literal `null` are both "no answer"
 * so callers can omit the key rather than emit `answer: null`.
 */
export function typedAnswerFromPayload(payload: unknown): unknown {
  if (!isPlainObject(payload)) return undefined
  if (!('answer' in payload)) return undefined
  const answer = payload.answer
  if (answer === undefined || answer === null) return undefined
  return answer
}

function unwrapAnswer(answer: unknown): { kind?: string; value: unknown } {
  if (isPlainObject(answer) && 'value' in answer) {
    const kind = typeof answer.kind === 'string' ? answer.kind : undefined
    return { kind, value: answer.value }
  }
  return { value: answer }
}

/**
 * Format a stored typed answer for a reviewer. `schema` is the request's
 * answerSchema when the host has one; without it, the answer `kind` (including
 * legacy aliases) still drives text / single / multi / number / boolean.
 */
export function formatTypedAnswer(
  answer: unknown,
  schema?: AnswerSchema | null,
): FormattedAnswer | null {
  if (answer === undefined || answer === null) return null
  try {
    const unwrapped = unwrapAnswer(answer)
    const type = schemaTypeOf(schema, unwrapped.kind)
    const value = unwrapped.value

    if (typeof value === 'boolean' && type !== 'binary') {
      return { kind: 'text', text: value ? 'Yes' : 'No' }
    }

    switch (type) {
      case 'text':
        return { kind: 'text', text: typeof value === 'string' ? value : asText(value) }
      case 'single':
        return { kind: 'text', text: optionLabel(schema, value) }
      case 'multi': {
        if (!Array.isArray(value)) return { kind: 'json', text: safeJson(value) }
        return { kind: 'list', items: value.map((item) => optionLabel(schema, item)) }
      }
      case 'number':
        return {
          kind: 'text',
          text: typeof value === 'number' && Number.isFinite(value) ? String(value) : asText(value),
        }
      case 'binary':
        if (value === true || value === 'approve') return { kind: 'text', text: 'Approve' }
        if (value === false || value === 'reject') return { kind: 'text', text: 'Reject' }
        return { kind: 'text', text: asText(value) }
      default: {
        if (typeof value === 'boolean') return { kind: 'text', text: value ? 'Yes' : 'No' }
        if (typeof value === 'string' || typeof value === 'number') return { kind: 'text', text: asText(value) }
        if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
          return { kind: 'list', items: value.map((item) => optionLabel(schema, item)) }
        }
        return { kind: 'json', text: safeJson(value) }
      }
    }
  } catch {
    return { kind: 'json', text: safeJson(answer) }
  }
}

/** True for null, undefined, `{}`, or `[]` — the empty payload box to hide. */
export function isEmptyPayload(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (isPlainObject(value)) return Object.keys(value).length === 0
  return false
}

/**
 * Detail/list title: the ask_user question when present, otherwise the tool
 * / action name (`ask_user` only as a last resort).
 */
export function workItemTitle(prompt?: string | null, actionName?: string | null): string {
  const question = typeof prompt === 'string' ? prompt.trim() : ''
  if (question) return question
  const name = typeof actionName === 'string' ? actionName.trim() : ''
  return name
}
