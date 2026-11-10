/**
 * Pure helpers for the mobile respond sheet (ask_user typed answers).
 * Mirrors the web `answer-form-helpers` on top of the SHARED rules in
 * @hitly/core; the host re-validates every submission against the STORED
 * schema, this is the client-side gate that keeps the reviewer's input on an
 * invalid submit (hitl-spec 7).
 */

import { validateAnswerAgainstSchema, type AnswerSchema } from '@hitly/core'

export type RespondPayload = {
  response?: string
  answer?: { kind: string; value: unknown }
}

/** Initial controlled value for one stored schema. Never pre-selects anything. */
export function initialRespondValue(schema?: AnswerSchema): unknown {
  if (!schema) return ''
  switch (schema.type) {
    case 'multi':
      return [] as string[]
    case 'number':
      return ''
    case 'single':
      return null
    default:
      return ''
  }
}

function toWireValue(schema: AnswerSchema, raw: unknown): unknown {
  if (schema.type === 'number' && typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : raw
  }
  return raw
}

/** Client-side mirror of the host gates; empty array = ready to send. */
export function respondErrors(schema: AnswerSchema | undefined, raw: unknown): string[] {
  if (!schema) return []
  if (schema.type === 'number' && (raw === '' || raw === null)) return ['Enter a number before responding.']
  if (schema.type === 'single' && (raw === null || raw === '')) return ['Pick one of the options before responding.']
  if (schema.type === 'multi' && Array.isArray(raw) && raw.length === 0) {
    return ['Pick at least one option before responding.']
  }
  return validateAnswerAgainstSchema(schema, { kind: schema.type, value: toWireValue(schema, raw) }).map(
    (error) => error.message,
  )
}

/**
 * Build the decide body extras for the respond button: a typed `answer` when
 * the request stores a schema, the legacy free-text `response` only without
 * one. `null` = invalid input, send nothing.
 */
export function buildRespondPayload(schema: AnswerSchema | undefined, raw: unknown): RespondPayload | null {
  if (!schema) return { response: typeof raw === 'string' ? raw : String(raw ?? '') }
  if (respondErrors(schema, raw).length > 0) return null
  return { answer: { kind: schema.type, value: toWireValue(schema, raw) } }
}
