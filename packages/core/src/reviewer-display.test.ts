import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AnswerSchema } from './answer-schema.ts'
import {
  formatTypedAnswer,
  isEmptyPayload,
  typedAnswerFromPayload,
  workItemTitle,
} from './reviewer-display.ts'

test('formatTypedAnswer: text is shown as text', () => {
  assert.deepEqual(formatTypedAnswer({ kind: 'text', value: 'ship it Tuesday' }, { type: 'text' }), {
    kind: 'text',
    text: 'ship it Tuesday',
  })
  assert.deepEqual(formatTypedAnswer({ kind: 'free_text', value: 'legacy free text' }, { type: 'text' }), {
    kind: 'text',
    text: 'legacy free text',
  })
})

test('formatTypedAnswer: single choice uses the option label', () => {
  const schema: AnswerSchema = {
    type: 'single',
    options: [
      { value: 'hall_a', label: 'Hall A' },
      { value: 'hall_b', label: 'Hall B' },
    ],
  }
  assert.deepEqual(formatTypedAnswer({ kind: 'single', value: 'hall_a' }, schema), {
    kind: 'text',
    text: 'Hall A',
  })
})

test('formatTypedAnswer: multi choice is a list of option labels', () => {
  const schema: AnswerSchema = {
    type: 'multi',
    options: [
      { value: 'secret', label: 'Secret' },
      { value: 'forms', label: 'Forms' },
      { value: 'push', label: 'Push' },
      { value: 'sso', label: 'SSO' },
    ],
  }
  assert.deepEqual(
    formatTypedAnswer({ kind: 'multi', value: ['secret', 'forms', 'push', 'sso'] }, schema),
    { kind: 'list', items: ['Secret', 'Forms', 'Push', 'SSO'] },
  )
})

test('formatTypedAnswer: number is shown as a number', () => {
  assert.deepEqual(formatTypedAnswer({ kind: 'number', value: 42 }, { type: 'number' }), {
    kind: 'text',
    text: '42',
  })
  assert.deepEqual(formatTypedAnswer({ kind: 'number', value: 3.5 }, { type: 'number' }), {
    kind: 'text',
    text: '3.5',
  })
})

test('formatTypedAnswer: number 0 renders as the text 0 (not empty / falsy)', () => {
  const formatted = formatTypedAnswer({ kind: 'number', value: 0 }, { type: 'number' })
  assert.deepEqual(formatted, { kind: 'text', text: '0' })
  assert.equal(formatted?.kind, 'text')
  assert.equal(formatted && formatted.kind === 'text' ? formatted.text : null, '0')
  assert.notEqual(formatted && formatted.kind === 'text' ? formatted.text : '0', '')
})

test('formatTypedAnswer: negative number renders as its signed decimal', () => {
  assert.deepEqual(formatTypedAnswer({ kind: 'number', value: -2.5 }, { type: 'number' }), {
    kind: 'text',
    text: '-2.5',
  })
})

test('formatTypedAnswer: empty multi-choice is an empty list and does not throw', () => {
  const schema: AnswerSchema = {
    type: 'multi',
    options: [
      { value: 'secret', label: 'Secret' },
      { value: 'forms', label: 'Forms' },
    ],
  }
  assert.deepEqual(formatTypedAnswer({ kind: 'multi', value: [] }, schema), {
    kind: 'list',
    items: [],
  })
})

test('formatTypedAnswer: missing option label falls back to the value', () => {
  const schema: AnswerSchema = {
    type: 'single',
    options: [{ value: 'hall_a', label: '' }, { value: 'hall_b', label: 'Hall B' }],
  }
  assert.deepEqual(formatTypedAnswer({ kind: 'single', value: 'hall_a' }, schema), {
    kind: 'text',
    text: 'hall_a',
  })
  assert.deepEqual(formatTypedAnswer({ kind: 'single', value: 'unknown' }, schema), {
    kind: 'text',
    text: 'unknown',
  })
  const multi: AnswerSchema = {
    type: 'multi',
    options: [{ value: 'secret', label: 'Secret' }],
  }
  assert.deepEqual(formatTypedAnswer({ kind: 'multi', value: ['secret', 'forms'] }, multi), {
    kind: 'list',
    items: ['Secret', 'forms'],
  })
})

test('formatTypedAnswer: boolean is Yes/No; binary is Approve/Reject', () => {
  assert.deepEqual(formatTypedAnswer({ kind: 'confirm', value: true }), { kind: 'text', text: 'Yes' })
  assert.deepEqual(formatTypedAnswer({ kind: 'confirm', value: false }), { kind: 'text', text: 'No' })
  assert.deepEqual(formatTypedAnswer({ kind: 'binary', value: 'approve' }, { type: 'binary' }), {
    kind: 'text',
    text: 'Approve',
  })
  assert.deepEqual(formatTypedAnswer({ kind: 'binary', value: 'reject' }, { type: 'binary' }), {
    kind: 'text',
    text: 'Reject',
  })
})

test('formatTypedAnswer: legacy shapes stay readable and never throw', () => {
  assert.deepEqual(formatTypedAnswer({ kind: 'multi_choice', value: ['secret', 'forms'] }), {
    kind: 'list',
    items: ['secret', 'forms'],
  })
  assert.deepEqual(formatTypedAnswer({ kind: 'single_choice', value: 'blue' }), {
    kind: 'text',
    text: 'blue',
  })
  assert.deepEqual(formatTypedAnswer('just a string'), { kind: 'text', text: 'just a string' })
  assert.deepEqual(formatTypedAnswer({ nested: { a: 1 } }), {
    kind: 'json',
    text: JSON.stringify({ nested: { a: 1 } }, null, 2),
  })
  assert.equal(formatTypedAnswer(null), null)
  assert.equal(formatTypedAnswer(undefined), null)

  const circular: { self?: unknown } = {}
  circular.self = circular
  const fallback = formatTypedAnswer(circular)
  assert.equal(fallback?.kind, 'json')
  assert.ok(fallback && fallback.kind === 'json' && fallback.text.length > 0)
})

test('typedAnswerFromPayload: reads answer and treats null as absent', () => {
  assert.deepEqual(typedAnswerFromPayload({ decision: 'respond', answer: { kind: 'text', value: 'hi' } }), {
    kind: 'text',
    value: 'hi',
  })
  assert.equal(typedAnswerFromPayload({ decision: 'respond' }), undefined)
  assert.equal(typedAnswerFromPayload({ decision: 'respond', answer: null }), undefined)
  assert.equal(typedAnswerFromPayload(null), undefined)
  assert.equal(typedAnswerFromPayload(['x']), undefined)
})

test('isEmptyPayload: hides {}, null, undefined, and []', () => {
  assert.equal(isEmptyPayload({}), true)
  assert.equal(isEmptyPayload(null), true)
  assert.equal(isEmptyPayload(undefined), true)
  assert.equal(isEmptyPayload([]), true)
  assert.equal(isEmptyPayload({ amount: 1 }), false)
  assert.equal(isEmptyPayload(['x']), false)
  assert.equal(isEmptyPayload(''), false)
  assert.equal(isEmptyPayload(0), false)
})

test('workItemTitle: question wins; tool name is the fallback', () => {
  assert.equal(workItemTitle('Which auth methods?', 'ask_user'), 'Which auth methods?')
  assert.equal(workItemTitle('  Trim me?  ', 'ask_user'), 'Trim me?')
  assert.equal(workItemTitle('', 'ask_user'), 'ask_user')
  assert.equal(workItemTitle(null, 'ask_user'), 'ask_user')
  assert.equal(workItemTitle(undefined, 'send-refund'), 'send-refund')
  assert.equal(workItemTitle('   ', 'ask_user'), 'ask_user')
})

test('workItemTitle: a very long question does not throw', () => {
  const long = `${'Which auth method should we enable for this workspace? '.repeat(40)}end`
  const title = workItemTitle(long, 'ask_user')
  assert.equal(title, long)
  assert.ok(title.length > 200)
})

test('formatTypedAnswer: a label containing <script> stays literal text', () => {
  const schema: AnswerSchema = {
    type: 'single',
    options: [{ value: 'xss', label: '<script>alert(1)</script>' }],
  }
  assert.deepEqual(formatTypedAnswer({ kind: 'single', value: 'xss' }, schema), {
    kind: 'text',
    text: '<script>alert(1)</script>',
  })
})
