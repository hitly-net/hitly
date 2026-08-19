import assert from 'node:assert/strict'
import { test } from 'node:test'
import { handleDecideError } from './decide-helpers'
import type { ApprovalDetail } from '../../types'

test('handleDecideError: reload succeeds with still-pending item → stay', async () => {
  const reloadedDetail: ApprovalDetail = {
    id: 'apr_1',
    status: 'pending',
    actionName: 'send-refund',
    plugin: 'mastra',
    projectId: 'prj_1',
    projectName: 'Test',
    assignedUserId: null,
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: null,
    envelope: {
      action: { name: 'send-refund', args: {} },
      allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false },
    },
    origin: { plugin: 'mastra', projectId: 'prj_1' },
    originFields: [],
    canAct: true,
    canCancel: true,
    decisions: [],
  }
  const reloadDetail = async () => reloadedDetail
  const outcome = await handleDecideError(reloadDetail)
  assert.deepEqual(outcome, { action: 'stay', detail: reloadedDetail })
})

test('handleDecideError: reload succeeds but now decided → stay', async () => {
  const reloadedDetail: ApprovalDetail = {
    id: 'apr_2',
    status: 'decided',
    actionName: 'send-refund',
    plugin: 'mastra',
    projectId: 'prj_1',
    projectName: 'Test',
    assignedUserId: null,
    createdAt: '2026-08-19T12:00:00Z',
    expiresAt: null,
    envelope: {
      action: { name: 'send-refund', args: {} },
      allowedActions: { accept: true, reject: true, edit: false, respond: false, ignore: false },
    },
    origin: { plugin: 'mastra', projectId: 'prj_1' },
    originFields: [],
    canAct: false,
    canCancel: false,
    decisions: [],
  }
  const reloadDetail = async () => reloadedDetail
  const outcome = await handleDecideError(reloadDetail)
  assert.deepEqual(outcome, { action: 'stay', detail: reloadedDetail })
})

test('handleDecideError: reload fails → back', async () => {
  const reloadDetail = async () => null
  const outcome = await handleDecideError(reloadDetail)
  assert.deepEqual(outcome, { action: 'back' })
})
