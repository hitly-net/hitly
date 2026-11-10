/**
 * Typed answer schemas for ask_user (hitl/v0: one question, one answer type).
 * Pure rules shared by MCP input validation, HTTP ingest persistence, the
 * reviewer clients' client-side gates, and the host decide re-validation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FORM_REJECTION_MESSAGE,
  parseAnswerSchema,
  validateAnswerAgainstSchema,
  validateDecisionAnswer,
  type AnswerSchema,
} from './answer-schema.ts'

test('parseAnswerSchema: absent schema is a valid no-op (legacy asks)', () => {
  assert.deepEqual(parseAnswerSchema(undefined), { ok: true, schema: undefined })
  assert.deepEqual(parseAnswerSchema(null), { ok: true, schema: undefined })
})

test('parseAnswerSchema: spec names are stored verbatim; aliases are mapped', () => {
  for (const [input, stored] of [
    ['text', 'text'],
    ['free_text', 'text'],
    ['single', 'single'],
    ['single_choice', 'single'],
    ['multi', 'multi'],
    ['multi_choice', 'multi'],
    ['number', 'number'],
  ] as const) {
    const options = stored === 'single' || stored === 'multi' ? ['a', 'b'] : undefined
    const result = parseAnswerSchema({ type: input, ...(options ? { options } : {}) })
    assert.equal(result.ok, true, `${input} must be accepted`)
    assert.equal((result as { schema: AnswerSchema }).schema?.type, stored)
  }
})

test('parseAnswerSchema: simple_form and fields[] are refused with the one-request-per-field message', () => {
  const form = parseAnswerSchema({ type: 'simple_form', fields: [{ name: 'headline' }] })
  assert.equal(form.ok, false)
  assert.equal((form as { error: string }).error, FORM_REJECTION_MESSAGE)
  assert.match(FORM_REJECTION_MESSAGE, /one request per field/)
  assert.match(FORM_REJECTION_MESSAGE, /separate ask_user/)

  const fieldsOnly = parseAnswerSchema({ type: 'text', fields: [{ name: 'notes' }] })
  assert.equal(fieldsOnly.ok, false)
  assert.equal((fieldsOnly as { error: string }).error, FORM_REJECTION_MESSAGE)
})

test('parseAnswerSchema: unknown type names are refused', () => {
  for (const type of ['date', 'secret', '', 'approve', undefined, 7]) {
    assert.equal(parseAnswerSchema({ type }).ok, false, `type ${String(type)} must be refused`)
  }
  assert.equal(parseAnswerSchema('text').ok, false, 'a bare string is not a schema')
})

test('parseAnswerSchema: string options normalise to spec {value, label} objects', () => {
  const result = parseAnswerSchema({ type: 'single_choice', options: ['Hall A', 'Hall B'] })
  assert.equal(result.ok, true)
  assert.deepEqual((result as { schema: AnswerSchema }).schema, {
    type: 'single',
    options: [
      { value: 'Hall A', label: 'Hall A' },
      { value: 'Hall B', label: 'Hall B' },
    ],
  })
})

test('parseAnswerSchema: spec option objects survive; label defaults to value; duplicates refused', () => {
  const ok = parseAnswerSchema({
    type: 'multi',
    options: [{ value: 'a', label: 'Alpha', description: 'first' }, { value: 'b' }],
  })
  assert.equal(ok.ok, true)
  assert.deepEqual((ok as { schema: AnswerSchema }).schema?.options, [
    { value: 'a', label: 'Alpha', description: 'first' },
    { value: 'b', label: 'b' },
  ])
  assert.equal(parseAnswerSchema({ type: 'single', options: ['a', 'a'] }).ok, false, 'duplicate values refused')
  assert.equal(parseAnswerSchema({ type: 'single', options: [{ value: 'a', nope: 1 }] }).ok, false, 'unknown option keys refused')
  assert.equal(parseAnswerSchema({ type: 'single', options: ['  '] }).ok, false, 'blank option refused')
})

test('parseAnswerSchema: single/multi need options; text/number refuse them', () => {
  assert.equal(parseAnswerSchema({ type: 'single' }).ok, false)
  assert.match(String((parseAnswerSchema({ type: 'multi_choice' }) as { error: string }).error), /multi needs options/)
  assert.equal(parseAnswerSchema({ type: 'text', options: ['a'] }).ok, false)
  assert.equal(parseAnswerSchema({ type: 'number', options: ['a'] }).ok, false)
})

test('parseAnswerSchema: bounds are persisted for the right type and sanity-checked', () => {
  const num = parseAnswerSchema({ type: 'number', bounds: { min: 0, max: 10, step: 0.5, unit: 'kg' } })
  assert.equal(num.ok, true)
  assert.deepEqual((num as { schema: AnswerSchema }).schema?.bounds, { min: 0, max: 10, step: 0.5, unit: 'kg' })

  assert.equal(parseAnswerSchema({ type: 'number', bounds: { step: 0 } }).ok, false, 'step 0 refused')
  assert.equal(parseAnswerSchema({ type: 'number', bounds: { step: -2 } }).ok, false, 'negative step refused')
  assert.equal(parseAnswerSchema({ type: 'number', bounds: { max: 1, min: 5 } }).ok, false, 'max < min refused')
  assert.equal(parseAnswerSchema({ type: 'number', bounds: { minLength: 1 } }).ok, false, 'text bound on number refused')
  assert.equal(parseAnswerSchema({ type: 'text', bounds: { minLength: 2, maxLength: 10, pattern: '^a+$' } }).ok, true)
  assert.equal(parseAnswerSchema({ type: 'text', bounds: { pattern: 'x'.repeat(257) } }).ok, false, 'pattern cap enforced')
  assert.equal(parseAnswerSchema({ type: 'multi', bounds: { minItems: 1, maxItems: 5 }, options: ['a', 'b'] }).ok, true)
  assert.equal(
    parseAnswerSchema({ type: 'multi', bounds: { minItems: 4, maxItems: 2 }, options: ['a', 'b'] }).ok,
    false,
    'maxItems < minItems refused',
  )
  assert.equal(parseAnswerSchema({ type: 'single', bounds: { min: 1 }, options: ['a'] }).ok, false, 'single takes no bounds')
})

const single: AnswerSchema = {
  type: 'single',
  options: [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ],
}
const multi: AnswerSchema = {
  type: 'multi',
  options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }],
  bounds: { minItems: 1, maxItems: 2 },
}
const number: AnswerSchema = { type: 'number', bounds: { min: 0, max: 10, step: 2 } }
const text: AnswerSchema = { type: 'text', bounds: { minLength: 2, maxLength: 5, pattern: '^[a-z]+$' } }

test('validateAnswerAgainstSchema: kind must equal the STORED spec type', () => {
  assert.deepEqual(validateAnswerAgainstSchema(single, { kind: 'single', value: 'a' }), [])
  const legacy = validateAnswerAgainstSchema(single, { kind: 'single_choice', value: 'a' })
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0]?.field, 'answer.kind')
  assert.deepEqual(validateAnswerAgainstSchema(single, 'a'), [{ field: 'answer', message: 'answer must be an object {kind, value}' }])
})

test('validateAnswerAgainstSchema: single accepts only declared option values', () => {
  assert.deepEqual(validateAnswerAgainstSchema(single, { kind: 'single', value: 'b' }), [])
  assert.equal(validateAnswerAgainstSchema(single, { kind: 'single', value: 'zzz' }).length, 1)
  assert.equal(validateAnswerAgainstSchema(single, { kind: 'single', value: ['a'] }).length, 1)
})

test('validateAnswerAgainstSchema: multi requires distinct declared values within min/max items', () => {
  assert.deepEqual(validateAnswerAgainstSchema(multi, { kind: 'multi', value: ['a', 'c'] }), [])
  assert.ok(validateAnswerAgainstSchema(multi, { kind: 'multi', value: [] }).length >= 1, 'minItems')
  assert.ok(validateAnswerAgainstSchema(multi, { kind: 'multi', value: ['a', 'b', 'c'] }).length >= 1, 'maxItems')
  assert.ok(validateAnswerAgainstSchema(multi, { kind: 'multi', value: ['a', 'a'] }).length >= 1, 'duplicates')
  assert.ok(validateAnswerAgainstSchema(multi, { kind: 'multi', value: ['a', 'nope'] }).length >= 1, 'unknown option')
  assert.ok(validateAnswerAgainstSchema(multi, { kind: 'multi', value: 'a' }).length === 1, 'not an array')
})

test('validateAnswerAgainstSchema: number honours min/max/step against the stored bounds', () => {
  assert.deepEqual(validateAnswerAgainstSchema(number, { kind: 'number', value: 4 }), [])
  assert.equal(validateAnswerAgainstSchema(number, { kind: 'number', value: 3 }).length, 1, 'step')
  assert.equal(validateAnswerAgainstSchema(number, { kind: 'number', value: -2 }).length, 1, 'min')
  assert.equal(validateAnswerAgainstSchema(number, { kind: 'number', value: 12 }).length, 1, 'max')
  assert.equal(validateAnswerAgainstSchema(number, { kind: 'number', value: '4' }).length, 1, 'string number refused')
  assert.equal(validateAnswerAgainstSchema({ type: 'number' }, { kind: 'number', value: 3.75 }).length, 0, 'no bounds = anything finite')
  assert.equal(validateAnswerAgainstSchema({ type: 'number' }, { kind: 'number', value: Number.NaN }).length, 1)
})

test('validateAnswerAgainstSchema: text bounds apply without trimming or coercing (spec 7)', () => {
  assert.deepEqual(validateAnswerAgainstSchema(text, { kind: 'text', value: 'abc' }), [])
  assert.equal(validateAnswerAgainstSchema(text, { kind: 'text', value: 'a' }).length, 1, 'minLength')
  assert.equal(validateAnswerAgainstSchema(text, { kind: 'text', value: 'abcdef' }).length, 1, 'maxLength')
  assert.equal(validateAnswerAgainstSchema(text, { kind: 'text', value: 'ABC' }).length, 1, 'pattern')
  // A value the client trimmed is simply validated as sent: the host never trims.
  const noTrim: AnswerSchema = { type: 'text', bounds: { minLength: 2 } }
  assert.deepEqual(validateAnswerAgainstSchema(noTrim, { kind: 'text', value: ' a ' }), [], 'spaces are content, not noise')
})

test('validateAnswerAgainstSchema: binary is approve/reject', () => {
  assert.deepEqual(validateAnswerAgainstSchema({ type: 'binary' }, { kind: 'binary', value: 'approve' }), [])
  assert.deepEqual(validateAnswerAgainstSchema({ type: 'binary' }, { kind: 'binary', value: 'reject' }), [])
  assert.equal(validateAnswerAgainstSchema({ type: 'binary' }, { kind: 'binary', value: 'maybe' }).length, 1)
})

test('validateDecisionAnswer: no stored schema keeps the legacy respond path untouched', () => {
  assert.deepEqual(validateDecisionAnswer({}, { decision: 'respond', response: 'hi' }), [])
  assert.deepEqual(validateDecisionAnswer({}, { decision: 'respond', answer: { kind: 'single_choice', value: 'a' } }), [])
  assert.deepEqual(validateDecisionAnswer({}, { decision: 'respond' }), [], 'legacy respond without anything stays valid')
})

test('validateDecisionAnswer: stored schema demands an answer and refuses a bare response', () => {
  const envelope = { answerSchema: single }
  const missing = validateDecisionAnswer(envelope, { decision: 'respond' })
  assert.equal(missing.length, 1)
  assert.equal(missing[0]?.field, 'answer')

  const substituted = validateDecisionAnswer(envelope, { decision: 'respond', response: 'Hall A' })
  assert.ok(substituted.some((error) => error.field === 'response'), 'bare response is refused as a substitute')
  assert.ok(substituted.some((error) => error.field === 'answer'), 'and the missing answer is reported')

  assert.deepEqual(validateDecisionAnswer(envelope, { decision: 'respond', answer: { kind: 'single', value: 'a' } }), [])
  assert.equal(validateDecisionAnswer(envelope, { decision: 'respond', answer: { kind: 'single', value: 'zzz' } }).length, 1)
})

test('validateDecisionAnswer: an answer on a non-respond decision is refused when a schema is stored', () => {
  assert.equal(validateDecisionAnswer({ answerSchema: single }, { decision: 'ignore', answer: { kind: 'single', value: 'a' } }).length, 1)
  assert.deepEqual(validateDecisionAnswer({ answerSchema: single }, { decision: 'ignore' }), [], 'Ignore stays available')
})
