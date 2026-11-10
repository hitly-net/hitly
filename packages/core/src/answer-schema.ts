/**
 * Typed answer schemas for `ask_user` (hitl-spec 3.3/3.4, 7).
 *
 * hitl/v0 is ONE question per request: `answerType` is the single answer type
 * of the request (spec 3.4), and the reviewer's `answer` is `{ kind, value }`
 * where `kind` is exactly that stored type. There are no forms and no
 * `fields[]` in v0 (Derek's ruling, 10 Nov 2026): several questions are
 * several `ask_user` requests.
 *
 * Pure functions only (no UI, no DB) so MCP, the HTTP plugin ingest, the web
 * client and the host decide path all validate against the same rules.
 */

import type { FieldError } from './answer-gates.ts'

export const ANSWER_SCHEMA_TYPES = ['text', 'single', 'multi', 'number', 'binary'] as const
export type AnswerSchemaType = (typeof ANSWER_SCHEMA_TYPES)[number]

/**
 * MCP-facing aliases (spec name in parentheses). Accepted on input, never
 * stored: the persisted `answerSchema.type` and the answer `kind` always use
 * the spec name.
 */
export const ANSWER_TYPE_ALIASES: Record<string, AnswerSchemaType> = {
  text: 'text',
  free_text: 'text',
  single: 'single',
  single_choice: 'single',
  multi: 'multi',
  multi_choice: 'multi',
  number: 'number',
  binary: 'binary',
}

/** Plain-language rejection for the removed `simple_form` (hitl/v0 has no forms). */
export const FORM_REJECTION_MESSAGE =
  'simple_form is not supported in v0. hitl/v0 is one request per field: send a separate ask_user for each question (one prompt, one answerSchema). A later release may add forms.'

export interface AnswerSchemaOption {
  value: string
  label: string
  description?: string
}

export interface AnswerBounds {
  /** number */
  min?: number
  max?: number
  step?: number
  unit?: string
  /** text */
  minLength?: number
  maxLength?: number
  pattern?: string
  /** multi */
  minItems?: number
  maxItems?: number
}

export interface AnswerSchema {
  type: AnswerSchemaType
  /** Required for `single` / `multi`; not allowed elsewhere. */
  options?: AnswerSchemaOption[]
  bounds?: AnswerBounds
}

const OPTION_KEYS = new Set(['value', 'label', 'description'])
const BOUNDS_KEYS = new Set(['min', 'max', 'step', 'unit', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'])
const TYPE_BOUND_KEYS: Record<AnswerSchemaType, string[]> = {
  number: ['min', 'max', 'step', 'unit'],
  text: ['minLength', 'maxLength', 'pattern'],
  multi: ['minItems', 'maxItems'],
  single: [],
  binary: [],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type ParseAnswerSchemaResult = { ok: true; schema?: AnswerSchema } | { ok: false; error: string }

/**
 * Validate + normalise an inbound `answerSchema` (from MCP or HTTP ingest).
 * Returns `{ ok: true, schema: undefined }` when absent. A malformed schema is
 * REFUSED, never silently dropped (spec 7): callers must surface the error.
 *
 * Accepts the MCP aliases (`free_text`, `single_choice`, `multi_choice`),
 * options as plain strings (each string is both value and label) or spec
 * objects `{ value, label?, description? }`, and stores only spec names.
 */
export function parseAnswerSchema(raw: unknown): ParseAnswerSchemaResult {
  if (raw === undefined || raw === null) return { ok: true, schema: undefined }
  if (!isPlainObject(raw)) return { ok: false, error: 'answerSchema must be an object with a "type"' }
  if (raw.type === 'simple_form' || 'fields' in raw) return { ok: false, error: FORM_REJECTION_MESSAGE }
  const mapped = typeof raw.type === 'string' ? ANSWER_TYPE_ALIASES[raw.type] : undefined
  if (!mapped) {
    return { ok: false, error: 'answerSchema.type must be one of text, single, multi, number (aliases free_text, single_choice, multi_choice are accepted)' }
  }

  let options: AnswerSchemaOption[] | undefined
  if (raw.options !== undefined && raw.options !== null) {
    if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 20) {
      return { ok: false, error: 'answerSchema.options must be a non-empty array of at most 20 items' }
    }
    if (mapped !== 'single' && mapped !== 'multi') {
      return { ok: false, error: `answerSchema.options are only allowed for single and multi (${mapped} does not take options)` }
    }
    options = []
    const seen = new Set<string>()
    for (const item of raw.options) {
      let value: string | undefined
      let label: string | undefined
      let description: string | undefined
      if (typeof item === 'string') {
        value = item.trim() || undefined
      } else if (isPlainObject(item)) {
        const extra = Object.keys(item).filter((key) => !OPTION_KEYS.has(key))
        if (extra.length > 0) return { ok: false, error: `answerSchema.options has unknown keys: ${extra.join(', ')}` }
        value = typeof item.value === 'string' && item.value.trim() ? item.value.trim() : undefined
        label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined
        description =
          typeof item.description === 'string' && item.description.trim() ? item.description.trim() : undefined
        if (description && description.length > 500) return { ok: false, error: 'answerSchema.options description must be at most 500 characters' }
      }
      if (!value) return { ok: false, error: 'answerSchema.options entries need a non-empty value (string or {value, label?, description?})' }
      if (value.length > 200) return { ok: false, error: 'answerSchema.options value must be at most 200 characters' }
      if (seen.has(value)) return { ok: false, error: `answerSchema.options value "${value}" is declared more than once` }
      seen.add(value)
      const option: AnswerSchemaOption = { value, label: label ?? value }
      if (description) option.description = description
      options.push(option)
    }
  }
  if ((mapped === 'single' || mapped === 'multi') && !options) {
    return { ok: false, error: `${mapped} needs options` }
  }

  let bounds: AnswerBounds | undefined
  if (raw.bounds !== undefined && raw.bounds !== null) {
    if (!isPlainObject(raw.bounds)) return { ok: false, error: 'answerSchema.bounds must be an object' }
    const allowedKeys = TYPE_BOUND_KEYS[mapped]
    for (const key of Object.keys(raw.bounds)) {
      if (!BOUNDS_KEYS.has(key)) return { ok: false, error: `answerSchema.bounds has unknown key: ${key}` }
      if (!allowedKeys.includes(key)) {
        return { ok: false, error: `answerSchema.bounds key "${key}" does not apply to ${mapped}` }
      }
    }
    bounds = {}
    for (const key of allowedKeys) {
      const value = (raw.bounds as Record<string, unknown>)[key]
      if (value === undefined || value === null) continue
      if (key === 'unit') {
        if (typeof value !== 'string' || !value.trim() || value.length > 40) {
          return { ok: false, error: 'answerSchema.bounds.unit must be a short non-empty string' }
        }
        bounds.unit = value
        continue
      }
      if (key === 'pattern') {
        if (typeof value !== 'string' || !value || value.length > 256) {
          return { ok: false, error: 'answerSchema.bounds.pattern must be a string of at most 256 characters' }
        }
        bounds.pattern = value
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `answerSchema.bounds.${key} must be a finite number` }
      }
      if ((key === 'step' && value <= 0) || ((key === 'minLength' || key === 'maxLength' || key === 'minItems' || key === 'maxItems') && (!Number.isInteger(value) || value < 0))) {
        return { ok: false, error: `answerSchema.bounds.${key} is invalid` }
      }
      ;(bounds as Record<string, number>)[key] = value
    }
    if (bounds.min !== undefined && bounds.max !== undefined && bounds.max < bounds.min) {
      return { ok: false, error: 'answerSchema.bounds.max must be >= min' }
    }
    if (bounds.minItems !== undefined && bounds.maxItems !== undefined && bounds.maxItems < bounds.minItems) {
      return { ok: false, error: 'answerSchema.bounds.maxItems must be >= minItems' }
    }
  }

  const schema: AnswerSchema = { type: mapped }
  if (options) schema.options = options
  if (bounds && Object.keys(bounds).length > 0) schema.bounds = bounds
  return { ok: true, schema }
}

/**
 * Validate a submitted `{ kind, value }` against the STORED schema (spec 7:
 * the host re-validates at submit against the stored request, never the
 * client's claimed kind, and never alters, trims or coerces the value).
 * Returns field errors; empty array means valid.
 */
export function validateAnswerAgainstSchema(schema: AnswerSchema, answer: unknown): FieldError[] {
  const errors: FieldError[] = []
  if (!isPlainObject(answer)) {
    return [{ field: 'answer', message: 'answer must be an object {kind, value}' }]
  }
  if (answer.kind !== schema.type) {
    errors.push({ field: 'answer.kind', message: `answer.kind must be "${schema.type}" (the stored answerType), got ${JSON.stringify(answer.kind)}` })
    return errors
  }
  const value = answer.value
  switch (schema.type) {
    case 'text': {
      if (typeof value !== 'string') {
        errors.push({ field: 'answer.value', message: 'answer.value must be a string' })
        break
      }
      const bounds = schema.bounds
      // Deliberately NO trim/coercion (spec 7).
      if (bounds?.minLength !== undefined && value.length < bounds.minLength) {
        errors.push({ field: 'answer.value', message: `answer.value must be at least ${bounds.minLength} characters` })
      }
      if (bounds?.maxLength !== undefined && value.length > bounds.maxLength) {
        errors.push({ field: 'answer.value', message: `answer.value must be at most ${bounds.maxLength} characters` })
      }
      if (bounds?.pattern !== undefined) {
        let matched = false
        try {
          matched = new RegExp(bounds.pattern).test(value)
        } catch {
          errors.push({ field: 'answer.value', message: 'the stored answerSchema.pattern is not a valid pattern' })
          break
        }
        if (!matched) errors.push({ field: 'answer.value', message: 'answer.value does not match the required pattern' })
      }
      break
    }
    case 'single': {
      const allowed = (schema.options ?? []).map((option) => option.value)
      if (typeof value !== 'string' || !allowed.includes(value)) {
        errors.push({ field: 'answer.value', message: `answer.value must be one of: ${allowed.join(', ')}` })
      }
      break
    }
    case 'multi': {
      const allowed = (schema.options ?? []).map((option) => option.value)
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        errors.push({ field: 'answer.value', message: 'answer.value must be an array of option values' })
        break
      }
      if (new Set(value).size !== value.length) {
        errors.push({ field: 'answer.value', message: 'answer.value must not repeat an option' })
      }
      for (const item of value) {
        if (!allowed.includes(item)) errors.push({ field: 'answer.value', message: `answer.value contains unknown option "${item}"` })
      }
      const bounds = schema.bounds
      if (bounds?.minItems !== undefined && value.length < bounds.minItems) {
        errors.push({ field: 'answer.value', message: `select at least ${bounds.minItems} options` })
      }
      if (bounds?.maxItems !== undefined && value.length > bounds.maxItems) {
        errors.push({ field: 'answer.value', message: `select at most ${bounds.maxItems} options` })
      }
      break
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ field: 'answer.value', message: 'answer.value must be a finite number' })
        break
      }
      const bounds = schema.bounds
      if (bounds?.min !== undefined && value < bounds.min) {
        errors.push({ field: 'answer.value', message: `answer.value must be at least ${bounds.min}` })
      }
      if (bounds?.max !== undefined && value > bounds.max) {
        errors.push({ field: 'answer.value', message: `answer.value must be at most ${bounds.max}` })
      }
      if (bounds?.step !== undefined) {
        const base = bounds.min ?? 0
        const ratio = (value - base) / bounds.step
        if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
          errors.push({ field: 'answer.value', message: `answer.value must be a multiple of step ${bounds.step}` })
        }
      }
      break
    }
    case 'binary': {
      if (value !== 'approve' && value !== 'reject') {
        errors.push({ field: 'answer.value', message: 'answer.value must be "approve" or "reject"' })
      }
      break
    }
  }
  return errors
}

/**
 * Host-side re-validation of a decide submission against the STORED schema.
 *
 * - No stored schema (in-flight asks created before persistence landed, and
 *   every non-ask_user request): today's legacy free-text `response` path is
 *   unchanged; a generic typed `answer` still passes `validateTypedAnswer`.
 * - Stored schema + `respond`: an `answer` is REQUIRED, its kind must equal
 *   the stored type, and a bare `response` is refused as a substitute (spec 7).
 * - Stored schema + any other decision: no `answer` (answers belong to respond).
 */
export function validateDecisionAnswer(
  envelope: { answerSchema?: AnswerSchema },
  payload: { decision: string; answer?: unknown; response?: string },
): FieldError[] {
  const schema = envelope.answerSchema
  if (!schema) return []
  const errors: FieldError[] = []
  if (payload.decision === 'respond') {
    if (payload.response !== undefined) {
      errors.push({
        field: 'response',
        message: 'This request has a typed answer schema: submit answer {kind, value}, not a free-text response.',
      })
    }
    if (payload.answer === undefined) {
      errors.push({ field: 'answer', message: `An answer of kind "${schema.type}" is required for this request.` })
    } else {
      errors.push(...validateAnswerAgainstSchema(schema, payload.answer))
    }
  } else if (payload.answer !== undefined) {
    errors.push({ field: 'answer', message: 'A typed answer is only accepted on a respond decision.' })
  }
  return errors
}
