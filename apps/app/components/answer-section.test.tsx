import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AnswerSchema } from '@hitly/core'

/**
 * Rendering rules for the ask_user respond controls (hitly/v0 widgets):
 * one typed widget per stored schema, the legacy "Response" box only when no
 * schema was stored, and NO code path that renders a multi-field form.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { AnswerSection } from './answer-section'

globalThis.FormData = window.FormData

afterEach(() => {
  cleanup()
})

function query(name: string): HTMLInputElement | null {
  return document.querySelector(name)
}

describe('AnswerSection widgets (ask_user, hitl/v0)', () => {
  it('renders nothing when respond is not allowed', () => {
    render(<AnswerSection respondAllowed={false} answerSchema={{ type: 'text' }} value="" onChange={() => undefined} />)
    assert.equal(query('[data-testid="answer-widget"]'), null)
    assert.equal(query('input[name="response"]'), null)
    assert.equal(query('input[name="answer"]'), null)
  })

  it('no schema + respond allowed keeps the legacy single "Response" box', () => {
    render(<AnswerSection respondAllowed={true} value="" onChange={() => undefined} />)
    const legacy = query('input[name="response"]')
    assert.ok(legacy, 'legacy free-text box must remain for asks without a stored schema')
    assert.equal(legacy.getAttribute('placeholder'), 'Response')
    assert.equal(query('[data-testid="answer-widget"]'), null)
    assert.equal(query('input[name="answer"]'), null)
  })

  it('text renders one text input, never a second field', () => {
    const schema: AnswerSchema = { type: 'text' }
    render(<AnswerSection respondAllowed={true} answerSchema={schema} value="hi" onChange={() => undefined} />)
    assert.equal(document.querySelectorAll('input, textarea, select').length, 2, 'one widget input + the hidden answer field, no form')
    const input = query('input[name="answer_text"]')!
    assert.equal(input.getAttribute('type'), 'text')
    assert.equal(input.value, 'hi')
    assert.equal(query('input[name="response"]'), null, 'no legacy box when a schema is stored')
  })

  it('single renders a radio group of the stored options', () => {
    const schema: AnswerSchema = {
      type: 'single',
      options: [
        { value: 'a', label: 'Alpha', description: 'first' },
        { value: 'b', label: 'Beta' },
      ],
    }
    const seen: unknown[] = []
    render(<AnswerSection respondAllowed={true} answerSchema={schema} value="a" onChange={(v) => seen.push(v)} />)
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    assert.equal(radios.length, 2)
    assert.deepEqual(
      radios.map((radio) => (radio as HTMLInputElement).value),
      ['a', 'b'],
    )
    assert.equal((radios[0] as HTMLInputElement).checked, true, 'the stored value is reflected')
    assert.equal((radios[1] as HTMLInputElement).checked, false)
    assert.ok(screen.getByText('first'), 'option descriptions render')
    fireEvent.click(radios[1]!)
    assert.deepEqual(seen, ['b'])
  })

  it('multi renders checkboxes and toggles distinct values', () => {
    const schema: AnswerSchema = {
      type: 'multi',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    }
    const seen: unknown[] = []
    render(<AnswerSection respondAllowed={true} answerSchema={schema} value={['a']} onChange={(v) => seen.push(v)} />)
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
    assert.equal(boxes.length, 2)
    assert.equal((boxes[0] as HTMLInputElement).checked, true)
    fireEvent.click(boxes[1]!)
    assert.deepEqual(seen, [['a', 'b']], 'checking adds a distinct value')
    cleanup()
    const seen2: unknown[] = []
    render(<AnswerSection respondAllowed={true} answerSchema={schema} value={['a', 'b']} onChange={(v) => seen2.push(v)} />)
    fireEvent.click(document.querySelectorAll('input[type="checkbox"]')[0]!)
    assert.deepEqual(seen2, [['b']], 'unchecking removes the value')
  })

  it('number renders a number input honouring stored bounds and showing the unit', () => {
    const schema: AnswerSchema = { type: 'number', bounds: { min: 0, max: 10, step: 2, unit: 'kg' } }
    render(<AnswerSection respondAllowed={true} answerSchema={schema} value={4} onChange={() => undefined} />)
    const input = query('input[name="answer_number"]')!
    assert.equal(input.getAttribute('type'), 'number')
    assert.equal(input.getAttribute('min'), '0')
    assert.equal(input.getAttribute('max'), '10')
    assert.equal(input.getAttribute('step'), '2')
    assert.ok(screen.getByText(/\(kg\)/), 'unit is shown in the label')
    assert.ok(screen.getByText(/0 … 10/), 'accepted range is shown')
  })

  it('binary/secret render nothing (approvals go through request_approval; secret needs encryption)', () => {
    render(<AnswerSection respondAllowed={true} answerSchema={{ type: 'binary' }} value="approve" onChange={() => undefined} />)
    assert.equal(query('[data-testid="answer-widget"]'), null)
    assert.equal(query('input[name="response"]'), null, 'binary must not degrade to a free-text box')
  })

  it('the hidden answer field carries the spec kind for the stored schema', () => {
    const schema: AnswerSchema = { type: 'single', options: [{ value: 'blue', label: 'Blue' }] }
    render(<AnswerSection respondAllowed={true} answerSchema={schema} value="blue" onChange={() => undefined} />)
    const hidden = query('input[name="answer"]') as HTMLInputElement
    assert.ok(hidden, 'answer carrier present')
    assert.deepEqual(JSON.parse(hidden.value), { kind: 'single', value: 'blue' })
  })
})
