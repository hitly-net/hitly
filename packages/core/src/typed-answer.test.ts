/**
 * Typed answer validation (PR hitly#106 item 7): a malformed answer must be
 * refused at parse time, never silently dropped or coerced.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { isTypedAnswer, validateTypedAnswer } from './typed-answer.ts'

describe('validateTypedAnswer', () => {
  it('accepts a well-formed typed answer', () => {
    assert.equal(validateTypedAnswer({ kind: 'single_choice', value: 'blue' }), null)
    assert.equal(validateTypedAnswer({ kind: 'free_text', value: 'ship it' }), null)
    assert.equal(validateTypedAnswer({ kind: 'multi_choice', value: ['a', 'b'] }), null)
    assert.equal(validateTypedAnswer({ kind: 'confirm', value: false }), null)
    assert.equal(validateTypedAnswer({ kind: 'number', value: 0 }), null)
    assert.equal(validateTypedAnswer({ kind: 'free_text', value: null }), null, 'explicit null value is a valid answer')
    assert.equal(isTypedAnswer({ kind: 'free_text', value: 'ok' }), true)
  })

  it('accepts absent answers', () => {
    assert.equal(validateTypedAnswer(undefined), null)
    assert.equal(isTypedAnswer(undefined), false, 'absent is not an answer')
  })

  it('refuses non-object answers instead of dropping them', () => {
    for (const bad of ['blue', 42, true, ['a'], null]) {
      assert.ok(validateTypedAnswer(bad), `must refuse ${JSON.stringify(bad)}`)
    }
  })

  it('refuses a missing or blank kind', () => {
    assert.ok(validateTypedAnswer({ value: 'x' }))
    assert.ok(validateTypedAnswer({ kind: '', value: 'x' }))
    assert.ok(validateTypedAnswer({ kind: '   ', value: 'x' }))
    assert.ok(validateTypedAnswer({ kind: 7, value: 'x' }))
  })

  it('refuses a missing value and non-JSON-representable values', () => {
    assert.ok(validateTypedAnswer({ kind: 'free_text' }))
    assert.ok(validateTypedAnswer({ kind: 'free_text', value: undefined }))
    assert.ok(validateTypedAnswer({ kind: 'free_text', value: Number.NaN }))
    assert.ok(validateTypedAnswer({ kind: 'free_text', value: () => 'x' }))
    const cyclic: Record<string, unknown> = { kind: 'free_text' }
    cyclic.value = cyclic
    assert.ok(validateTypedAnswer(cyclic))
  })
})
