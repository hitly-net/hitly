import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canShowEdit, pickAllowlistedArgs, buildEditSubmit } from './edit-helpers'

describe('canShowEdit', () => {
  it('returns true when edit allowed and editableFields has keys', () => {
    const result = canShowEdit(true, { amount: {} })
    assert.equal(result, true)
  })

  it('returns false when edit allowed but editableFields is empty (fail-closed)', () => {
    const result = canShowEdit(true, {})
    assert.equal(result, false)
  })

  it('returns false when edit allowed but editableFields is undefined', () => {
    const result = canShowEdit(true, undefined)
    assert.equal(result, false)
  })

  it('returns false when edit not allowed even if editableFields has keys', () => {
    const result = canShowEdit(false, { amount: {} })
    assert.equal(result, false)
  })
})

describe('pickAllowlistedArgs', () => {
  it('only includes allowlisted keys, drops orderId and extra', () => {
    const result = pickAllowlistedArgs(
      { amount: 12, orderId: 'x', extra: 1 },
      { amount: {} },
    )
    assert.deepEqual(result, { amount: 12 })
  })
})

describe('buildEditSubmit', () => {
  it('builds payload with editedArgs, editReason, and editReasonText as siblings', () => {
    const result = buildEditSubmit({
      values: { amount: 12, extra: 1 },
      fields: { amount: {} },
      editReason: 'pricing_correction',
      editReasonText: 'typo',
    })
    assert.deepEqual(result, {
      editedArgs: { amount: 12 },
      editReason: 'pricing_correction',
      editReasonText: 'typo',
    })
    assert.equal('extra' in result.editedArgs, false)
    assert.equal('editReason' in result.editedArgs, false)
  })

  it('omits editReason and editReasonText when not provided', () => {
    const result = buildEditSubmit({
      values: { amount: 12 },
      fields: { amount: {} },
    })
    assert.deepEqual(result, {
      editedArgs: { amount: 12 },
    })
    assert.equal('editReason' in result, false)
    assert.equal('editReasonText' in result, false)
  })
})
