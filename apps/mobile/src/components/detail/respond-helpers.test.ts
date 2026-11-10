import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AnswerSchema } from '@hitly/core'
import { buildRespondPayload, initialRespondValue, respondErrors } from './respond-helpers'

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
  bounds: { maxItems: 1 },
}
const number: AnswerSchema = { type: 'number', bounds: { min: 0, max: 10, step: 2 } }

describe('respond-helpers (ask_user typed answers)', () => {
  it('never pre-selects anything', () => {
    assert.equal(initialRespondValue(single), null)
    assert.deepEqual(initialRespondValue(multi), [])
    assert.equal(initialRespondValue(number), '')
    assert.equal(initialRespondValue({ type: 'text' }), '')
    assert.equal(initialRespondValue(undefined), '')
  })

  it('legacy (no schema) sends a free-text response, never an answer', () => {
    assert.deepEqual(buildRespondPayload(undefined, 'hello'), { response: 'hello' })
  })

  it('single submits the stored spec kind, not the MCP alias', () => {
    assert.equal(respondErrors(single, 'b').length, 0)
    assert.deepEqual(buildRespondPayload(single, 'b'), { answer: { kind: 'single', value: 'b' } })
    assert.equal(buildRespondPayload(single, 'zzz'), null, 'unknown option refused before send')
    assert.equal(buildRespondPayload(single, null), null, 'nothing picked yet')
    assert.equal(buildRespondPayload(single, 'single_choice' as unknown as string), null, 'a kind is not a value')
  })

  it('multi honours distinctness and maxItems from the stored schema', () => {
    assert.deepEqual(buildRespondPayload(multi, ['a']), { answer: { kind: 'multi', value: ['a'] } })
    assert.equal(buildRespondPayload(multi, ['a', 'b']), null, 'maxItems 1 exceeded')
    assert.equal(buildRespondPayload(multi, []), null, 'nothing picked yet')
  })

  it('number parses the typed string onto a wire number and enforces bounds', () => {
    assert.deepEqual(buildRespondPayload(number, '4'), { answer: { kind: 'number', value: 4 } })
    assert.equal(buildRespondPayload(number, ''), null, 'blank refused')
    assert.equal(buildRespondPayload(number, 'abc'), null, 'junk refused')
    assert.equal(buildRespondPayload(number, '3'), null, 'off step')
    assert.equal(buildRespondPayload(number, '11'), null, 'over max')
  })
})
