import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resultLabel } from './WorkItemRow.helpers'
import type { WorkItemRow } from '../../types'

test('WorkItemRow: decided + accept shows accepted', () => {
  const item: WorkItemRow = {
    id: 'apr_1',
    status: 'decided',
    decision: 'accept',
    actionName: 'send-refund',
    plugin: 'mastra',
    projectId: 'prj_1',
    projectName: 'Test',
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: null,
  }
  assert.equal(resultLabel(item), 'accepted')
})

test('WorkItemRow: decided + reject shows rejected', () => {
  const item: WorkItemRow = {
    id: 'apr_2',
    status: 'decided',
    decision: 'reject',
    actionName: 'send-refund',
    plugin: 'mastra',
    projectId: 'prj_1',
    projectName: 'Test',
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: null,
  }
  assert.equal(resultLabel(item), 'rejected')
})

test('WorkItemRow: failed_resume shows failed resume', () => {
  const item: WorkItemRow = {
    id: 'apr_3',
    status: 'failed_resume',
    actionName: 'send-refund',
    plugin: 'temporal',
    projectId: 'prj_1',
    projectName: 'Test',
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: null,
  }
  assert.equal(resultLabel(item), 'failed resume')
})

test('WorkItemRow: pending shows pending', () => {
  const item: WorkItemRow = {
    id: 'apr_4',
    status: 'pending',
    actionName: 'send-refund',
    plugin: 'langgraph',
    projectId: 'prj_1',
    projectName: 'Test',
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: '2026-08-19T13:00:00Z',
  }
  assert.equal(resultLabel(item), 'pending')
})
