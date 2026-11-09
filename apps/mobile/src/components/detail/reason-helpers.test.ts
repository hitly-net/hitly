import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canSubmitReason,
  openReasonFlow,
  reasonDecidePayload,
  reasonFlowAfterDecide,
  type ReasonFlow,
} from './reason-helpers'

const rejectFlow = (): ReasonFlow<{ response?: string }> => ({
  decision: 'reject',
  extra: { response: 'note' },
  reason: 'Amount too high',
})

describe('canSubmitReason', () => {
  it('refuses blank and whitespace-only reasons', () => {
    assert.equal(canSubmitReason(''), false)
    assert.equal(canSubmitReason('   '), false)
  })

  it('accepts a non-blank reason without changing it', () => {
    assert.equal(canSubmitReason('Amount too high'), true)
    assert.equal(canSubmitReason('  keep the spaces  '), true)
  })
})

describe('openReasonFlow (S11)', () => {
  it('starts empty when no sheet is open', () => {
    const flow = openReasonFlow(null, 'reject')
    assert.deepEqual(flow, { decision: 'reject', extra: undefined, reason: '' })
  })

  it('keeps the typed reason when the same decision is gated again', () => {
    const current = rejectFlow()
    const flow = openReasonFlow(current, 'reject', { response: 'other' })
    assert.equal(flow.reason, 'Amount too high')
    assert.equal(flow.decision, 'reject')
    assert.deepEqual(flow.extra, { response: 'other' })
  })

  it('starts a fresh reason when the decision changes', () => {
    const current = rejectFlow()
    const flow = openReasonFlow(current, 'accept')
    assert.deepEqual(flow, { decision: 'accept', extra: undefined, reason: '' })
  })
})

describe('reasonDecidePayload (S11)', () => {
  it('sends the typed reason without clearing the flow first', () => {
    const flow = rejectFlow()
    const payload = reasonDecidePayload(flow)
    assert.deepEqual(payload, {
      decision: 'reject',
      extra: { response: 'note', reason: 'Amount too high' },
    })
    assert.equal(flow.reason, 'Amount too high')
  })

  it('does not trim the stored reason (emptiness check only)', () => {
    const flow: ReasonFlow<object> = { decision: 'reject', reason: '  padded  ' }
    const payload = reasonDecidePayload(flow)
    assert.equal(payload?.extra.reason, '  padded  ')
  })

  it('returns null for a whitespace-only reason so the sheet stays put', () => {
    const flow: ReasonFlow<object> = { decision: 'reject', reason: '   ' }
    assert.equal(reasonDecidePayload(flow), null)
    assert.equal(flow.reason, '   ')
  })
})

describe('reasonFlowAfterDecide (S11)', () => {
  it('keeps the typed reason when decide is refused or fails', () => {
    const flow = rejectFlow()
    const kept = reasonFlowAfterDecide(flow, 'failure')
    assert.equal(kept, flow)
    assert.equal(kept?.reason, 'Amount too high')
  })

  it('clears the sheet only after a successful decide', () => {
    const flow = rejectFlow()
    assert.equal(reasonFlowAfterDecide(flow, 'success'), null)
  })
})
