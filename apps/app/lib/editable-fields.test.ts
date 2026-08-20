import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeEditableArgs, validateEditReason } from './approvals'

test('mergeEditableArgs: basic string field', () => {
  const result = mergeEditableArgs({
    originalArgs: { orderId: 'OR-123', amount: 100 },
    editedArgs: { amount: 50 },
    editableFields: {
      amount: { type: 'int', min: 1 },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.deepEqual(result.mergedArgs, { orderId: 'OR-123', amount: 50 })
  assert.deepEqual(result.editedDelta, { amount: 50 })
})

test('mergeEditableArgs: rejects extra keys', () => {
  const result = mergeEditableArgs({
    originalArgs: { orderId: 'OR-123', amount: 100 },
    editedArgs: { orderId: 'OR-999', amount: 50 },
    editableFields: {
      amount: { type: 'int', min: 1 },
    },
  })

  assert.ok('error' in result)
  assert.equal(result.error, 'Field "orderId" is not editable')
  assert.equal(result.status, 400)
})

test('mergeEditableArgs: int field validation', () => {
  const resultMin = mergeEditableArgs({
    originalArgs: { amount: 100 },
    editedArgs: { amount: 0 },
    editableFields: {
      amount: { type: 'int', min: 1, max: 500 },
    },
  })

  assert.ok('error' in resultMin)
  assert.equal(resultMin.error, 'Field "amount" is below minimum 1')

  const resultMax = mergeEditableArgs({
    originalArgs: { amount: 100 },
    editedArgs: { amount: 600 },
    editableFields: {
      amount: { type: 'int', min: 1, max: 500 },
    },
  })

  assert.ok('error' in resultMax)
  assert.equal(resultMax.error, 'Field "amount" exceeds maximum 500')

  const resultNotInt = mergeEditableArgs({
    originalArgs: { amount: 100 },
    editedArgs: { amount: 10.5 },
    editableFields: {
      amount: { type: 'int', min: 1 },
    },
  })

  assert.ok('error' in resultNotInt)
  assert.equal(resultNotInt.error, 'Field "amount" must be an integer')
})

test('mergeEditableArgs: float field validation', () => {
  const result = mergeEditableArgs({
    originalArgs: { price: 10.5 },
    editedArgs: { price: 20.75 },
    editableFields: {
      price: { type: 'float', min: 0, max: 100 },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.equal(result.mergedArgs.price, 20.75)

  const resultNaN = mergeEditableArgs({
    originalArgs: { price: 10.5 },
    editedArgs: { price: NaN },
    editableFields: {
      price: { type: 'float' },
    },
  })

  assert.ok('error' in resultNaN)
  assert.equal(resultNaN.error, 'Field "price" must be a finite number')
})

test('mergeEditableArgs: string field validation', () => {
  const result = mergeEditableArgs({
    originalArgs: { note: 'old' },
    editedArgs: { note: 'new note' },
    editableFields: {
      note: { type: 'string', minLength: 3, maxLength: 20 },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.equal(result.mergedArgs.note, 'new note')

  const resultTooShort = mergeEditableArgs({
    originalArgs: { note: 'old' },
    editedArgs: { note: 'ab' },
    editableFields: {
      note: { type: 'string', minLength: 3 },
    },
  })

  assert.ok('error' in resultTooShort)
  assert.equal(resultTooShort.error, 'Field "note" is below min length 3')

  const resultTooLong = mergeEditableArgs({
    originalArgs: { note: 'old' },
    editedArgs: { note: 'this is way too long for the field' },
    editableFields: {
      note: { type: 'string', maxLength: 20 },
    },
  })

  assert.ok('error' in resultTooLong)
  assert.equal(resultTooLong.error, 'Field "note" exceeds max length 20')
})

test('mergeEditableArgs: bool field', () => {
  const result = mergeEditableArgs({
    originalArgs: { urgent: false },
    editedArgs: { urgent: true },
    editableFields: {
      urgent: { type: 'bool' },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.equal(result.mergedArgs.urgent, true)

  const resultInvalid = mergeEditableArgs({
    originalArgs: { urgent: false },
    editedArgs: { urgent: 'yes' as unknown as boolean },
    editableFields: {
      urgent: { type: 'bool' },
    },
  })

  assert.ok('error' in resultInvalid)
  assert.equal(resultInvalid.error, 'Field "urgent" must be a boolean')
})

test('mergeEditableArgs: enum field with string options', () => {
  const result = mergeEditableArgs({
    originalArgs: { status: 'pending' },
    editedArgs: { status: 'approved' },
    editableFields: {
      status: { type: 'enum', options: ['pending', 'approved', 'rejected'] },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.equal(result.mergedArgs.status, 'approved')

  const resultInvalid = mergeEditableArgs({
    originalArgs: { status: 'pending' },
    editedArgs: { status: 'unknown' },
    editableFields: {
      status: { type: 'enum', options: ['pending', 'approved', 'rejected'] },
    },
  })

  assert.ok('error' in resultInvalid)
  assert.ok(resultInvalid.error.includes('must be one of'))
})

test('mergeEditableArgs: enum field with object options', () => {
  const result = mergeEditableArgs({
    originalArgs: { type: 'full' },
    editedArgs: { type: 'partial' },
    editableFields: {
      type: {
        type: 'enum',
        options: [
          { value: 'full', text: 'Full refund' },
          { value: 'partial', text: 'Partial refund' },
        ],
      },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.equal(result.mergedArgs.type, 'partial')
})

test('mergeEditableArgs: enum field with empty options', () => {
  const result = mergeEditableArgs({
    originalArgs: { type: 'full' },
    editedArgs: { type: 'partial' },
    editableFields: {
      type: { type: 'enum', options: [] },
    },
  })

  assert.ok('error' in result)
  assert.equal(result.error, 'Field "type" has no valid options')
})

test('mergeEditableArgs: array field with string items', () => {
  const result = mergeEditableArgs({
    originalArgs: { tags: ['old'] },
    editedArgs: { tags: ['new', 'updated'] },
    editableFields: {
      tags: { type: 'array', items: 'string', minItems: 1, maxItems: 5 },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.deepEqual(result.mergedArgs.tags, ['new', 'updated'])

  const resultTooFew = mergeEditableArgs({
    originalArgs: { tags: ['old'] },
    editedArgs: { tags: [] },
    editableFields: {
      tags: { type: 'array', items: 'string', minItems: 1 },
    },
  })

  assert.ok('error' in resultTooFew)
  assert.equal(resultTooFew.error, 'Field "tags" requires at least 1 items')

  const resultTooMany = mergeEditableArgs({
    originalArgs: { tags: ['old'] },
    editedArgs: { tags: ['a', 'b', 'c', 'd', 'e', 'f'] },
    editableFields: {
      tags: { type: 'array', items: 'string', maxItems: 5 },
    },
  })

  assert.ok('error' in resultTooMany)
  assert.equal(resultTooMany.error, 'Field "tags" exceeds maximum 5 items')
})

test('mergeEditableArgs: array field with int items', () => {
  const result = mergeEditableArgs({
    originalArgs: { quantities: [1, 2] },
    editedArgs: { quantities: [5, 10, 15] },
    editableFields: {
      quantities: { type: 'array', items: 'int' },
    },
  })

  assert.ok('mergedArgs' in result)
  assert.deepEqual(result.mergedArgs.quantities, [5, 10, 15])

  const resultInvalid = mergeEditableArgs({
    originalArgs: { quantities: [1, 2] },
    editedArgs: { quantities: [5, 10.5, 15] },
    editableFields: {
      quantities: { type: 'array', items: 'int' },
    },
  })

  assert.ok('error' in resultInvalid)
  assert.equal(resultInvalid.error, 'Field "quantities" must contain only integers')
})

test('validateEditReason: required dropdown', () => {
  const result = validateEditReason({
    editReason: undefined,
    editReasonConfig: {
      dropdown: { required: true },
    },
  })

  assert.ok(result)
  assert.equal(result.error, 'Edit reason dropdown is required')
})

test('validateEditReason: dropdown value validation', () => {
  const result = validateEditReason({
    editReason: 'invalid_value',
    editReasonConfig: {
      dropdown: { options: ['customer_request', 'pricing_correction', 'other'] },
    },
  })

  assert.ok(result)
  assert.ok(result.error.includes('must be one of'))
})

test('validateEditReason: required text', () => {
  const result = validateEditReason({
    editReasonText: '',
    editReasonConfig: {
      text: { required: true },
    },
  })

  assert.ok(result)
  assert.equal(result.error, 'Edit reason text is required')
})

test('validateEditReason: text maxLength', () => {
  const result = validateEditReason({
    editReasonText: 'a'.repeat(3000),
    editReasonConfig: {
      text: { maxLength: 2000 },
    },
  })

  assert.ok(result)
  assert.equal(result.error, 'Edit reason text exceeds maximum length 2000')
})

test('validateEditReason: valid with both controls', () => {
  const result = validateEditReason({
    editReason: 'customer_request',
    editReasonText: 'Customer threatened chargeback',
    editReasonConfig: {
      dropdown: { required: true },
      text: { maxLength: 2000 },
    },
  })

  assert.equal(result, null)
})

test('validateEditReason: hidden dropdown', () => {
  const result = validateEditReason({
    editReason: undefined,
    editReasonConfig: {
      dropdown: false,
      text: { required: true },
    },
  })

  // Should not validate dropdown when hidden
  assert.ok(result)
  assert.equal(result.error, 'Edit reason text is required')
})

test('validateEditReason: omitted config validates with defaults', () => {
  // Valid with defaults (optional controls)
  const result = validateEditReason({
    editReason: 'customer_request',
    editReasonText: 'Customer requested',
    editReasonConfig: undefined,
  })
  assert.equal(result, null)

  // Invalid: dropdown value not in defaults
  const resultInvalid = validateEditReason({
    editReason: 'not_in_defaults',
    editReasonConfig: undefined,
  })
  assert.ok(resultInvalid)
  assert.ok(resultInvalid.error.includes('must be one of'))

  // Invalid: text too long (default maxLength 2000)
  const resultTooLong = validateEditReason({
    editReasonText: 'a'.repeat(2001),
    editReasonConfig: undefined,
  })
  assert.ok(resultTooLong)
  assert.equal(resultTooLong.error, 'Edit reason text exceeds maximum length 2000')
})
