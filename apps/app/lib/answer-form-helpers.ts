/**
 * Pure answer-widget helpers shared by the web answer form and its tests.
 * The AUTHORITATIVE validation is the host's (`validateDecisionAnswer` in
 * @hitly/core, re-run on every decide); these helpers are the client-side
 * mirror so a reviewer keeps their input on an invalid submit instead of
 * bouncing through the server (hitl-spec 7).
 */

import { validateAnswerAgainstSchema, type AnswerSchema } from '@hitly/core'

/** Initial controlled value for one stored schema. Never pre-selects anything. */
export function initialAnswerValue(schema: AnswerSchema): unknown {
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

/** Coerce raw widget input onto the wire value (no trimming, no coercion of text). */
export function toWireValue(schema: AnswerSchema, raw: unknown): unknown {
  if (schema.type === 'number') {
    if (typeof raw === 'number') return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : raw // leave junk for the validators to reject
    }
    return raw
  }
  return raw
}

/** Client-side mirror of the host's answer gates; empty array = ready to submit. */
export function clientAnswerErrors(schema: AnswerSchema, raw: unknown): string[] {
  const value = toWireValue(schema, raw)
  if (schema.type === 'number' && (value === '' || value === null)) {
    return ['Enter a number before responding.']
  }
  if (schema.type === 'single' && (value === null || value === '')) {
    return ['Pick one of the options before responding.']
  }
  if (schema.type === 'multi' && Array.isArray(value) && value.length === 0) {
    return ['Pick at least one option before responding.']
  }
  const errors = validateAnswerAgainstSchema(schema, { kind: schema.type, value })
  return errors.map((error) => error.message)
}

/** Serialise the widget value onto the decide form's `answer` field. */
export function buildAnswerJson(schema: AnswerSchema, raw: unknown): string {
  return JSON.stringify({ kind: schema.type, value: toWireValue(schema, raw) })
}

/**
 * Parse the decide form's `answer` field back into a typed answer.
 * Returns { ok:false } on malformed JSON or a non-object — the caller must
 * refuse, never drop the reviewer's answer (hitl-spec 7).
 */
export function parseAnswerField(raw: string | null | undefined): { ok: true; answer?: unknown } | { ok: false; error: string } {
  const text = (raw ?? '').trim()
  if (!text) return { ok: true }
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'answer must be an object {kind, value}' }
    }
    return { ok: true, answer: parsed }
  } catch {
    return { ok: false, error: 'answer is not valid JSON' }
  }
}
