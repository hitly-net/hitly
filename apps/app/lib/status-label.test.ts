import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatStatusLabel } from './status-label'

test('formatStatusLabel: decided + accept returns "decided: accept"', () => {
  assert.equal(formatStatusLabel('decided', 'accept'), 'decided: accept')
})

test('formatStatusLabel: decided + reject returns "decided: reject"', () => {
  assert.equal(formatStatusLabel('decided', 'reject'), 'decided: reject')
})

test('formatStatusLabel: decided + edit returns "decided: edit"', () => {
  assert.equal(formatStatusLabel('decided', 'edit'), 'decided: edit')
})

test('formatStatusLabel: decided + respond returns "decided: respond"', () => {
  assert.equal(formatStatusLabel('decided', 'respond'), 'decided: respond')
})

test('formatStatusLabel: decided + ignore returns "decided: ignore"', () => {
  assert.equal(formatStatusLabel('decided', 'ignore'), 'decided: ignore')
})

test('formatStatusLabel: decided + cancel returns "decided: cancel"', () => {
  assert.equal(formatStatusLabel('decided', 'cancel'), 'decided: cancel')
})

test('formatStatusLabel: decided without decision returns "decided"', () => {
  assert.equal(formatStatusLabel('decided'), 'decided')
  assert.equal(formatStatusLabel('decided', null), 'decided')
})

test('formatStatusLabel: pending returns "pending"', () => {
  assert.equal(formatStatusLabel('pending'), 'pending')
})

test('formatStatusLabel: failed_resume returns "failed_resume"', () => {
  assert.equal(formatStatusLabel('failed_resume'), 'failed_resume')
})

test('formatStatusLabel: expired returns "expired"', () => {
  assert.equal(formatStatusLabel('expired'), 'expired')
})

test('formatStatusLabel: cancelled returns "cancelled"', () => {
  assert.equal(formatStatusLabel('cancelled'), 'cancelled')
})
