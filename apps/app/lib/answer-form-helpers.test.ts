import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AnswerSchema } from '@hitly/core'
import { buildAnswerJson, clientAnswerErrors, initialAnswerValue, parseAnswerField, toWireValue } from './answer-form-helpers'

/**
 * Pure client-side mirror of the host answer gates (the host is
 * authoritative: validateDecisionAnswer re-runs on every decide).
 */

const single: AnswerSchema = {
  type: 'single',
  options: [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
  ],
}
const multi: AnswerSchema = {
  type: 'multi',
  options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
  bounds: { minItems: 1, maxItems: 2 },
}
const number: AnswerSchema = { type: 'number', bounds: { min: 0, max: 10, step: 2 } }
const text: AnswerSchema = { type: 'text', bounds: { minLength: 2 } }

describe('answer-form-helpers', () => {
  it('initial values pre-select nothing (spec 3.5)', () => {
    assert.equal(initialAnswerValue(single), null)
    assert.equal(initialAnswerValue({ type: 'multi', options: [{ value: 'a', label: 'A' }] }) instanceof Array, true)
    assert.equal((initialAnswerValue(multi) as string[]).length, 0)
    assert.equal(initialAnswerValue(number), '')
  })

  it('number coerces a typed string to a wire number; junk stays for the validator', () => {
    assert.equal(toWireValue(number, '4'), 4)
    assert.equal(toWireValue(number, '4.5'), 4.5)
    assert.equal(toWireValue(number, 'abc'), 'abc')
    assert.equal(toWireValue(number, ''), '')
  })

  it('text values are never trimmed or coerced (spec 7)', () => {
    assert.equal(toWireValue(text, '  spaced  '), '  spaced  ')
    assert.deepEqual(clientAnswerErrors(text, '  a  '), [], 'spaces count toward minLength as content')
    assert.equal(clientAnswerErrors(text, 'a').length, 1, 'minLength applies to the verbatim value')
  })

  it('client gate refuses empty picks before they leave the form', () => {
    assert.ok(clientAnswerErrors(single, null).length > 0)
    assert.ok(clientAnswerErrors(multi, []).length > 0)
    assert.ok(clientAnswerErrors(number, '').length > 0)
    assert.equal(clientAnswerErrors(single, 'b').length, 0)
    assert.equal(clientAnswerErrors(multi, ['a', 'b']).length, 0)
    assert.equal(clientAnswerErrors(number, '4').length, 0)
  })

  it('client gate mirrors the host rules: options, bounds, kind', () => {
    assert.ok(clientAnswerErrors(single, 'zzz').length > 0, 'unknown option')
    assert.ok(clientAnswerErrors(multi, ['a', 'b', 'a']).length > 0, 'duplicate + maxItems')
    assert.ok(clientAnswerErrors(number, '11').length > 0, 'max')
    assert.ok(clientAnswerErrors(number, '3').length > 0, 'step')
  })

  it('buildAnswerJson emits the spec kind with the wire value', () => {
    assert.equal(buildAnswerJson(single, 'b'), JSON.stringify({ kind: 'single', value: 'b' }))
    assert.equal(buildAnswerJson(number, '4'), JSON.stringify({ kind: 'number', value: 4 }))
    assert.equal(buildAnswerJson({ type: 'text' }, 'Ship on Tuesday'), JSON.stringify({ kind: 'text', value: 'Ship on Tuesday' }))
  })

  it('parseAnswerField refuses malformed JSON instead of dropping the answer', () => {
    assert.deepEqual(parseAnswerField(null), { ok: true })
    assert.deepEqual(parseAnswerField('   '), { ok: true })
    assert.deepEqual(parseAnswerField('{"kind":"text","value":"x"}'), { ok: true, answer: { kind: 'text', value: 'x' } })
    assert.equal(parseAnswerField('{oops').ok, false)
    assert.equal(parseAnswerField('"bare"').ok, false)
    assert.equal(parseAnswerField('[1,2]').ok, false)
  })
})
