import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createOnceCutoff,
  createOncePolicy,
  createOnceRetentionDays,
  DEFAULT_CREATE_ONCE_RETENTION_DAYS,
  withinCreateOnceWindow,
} from './create-once'

const DAY = 24 * 60 * 60 * 1000

test('create-once retention: default is 10 days and is published in seconds', () => {
  assert.equal(DEFAULT_CREATE_ONCE_RETENTION_DAYS, 10)
  assert.equal(createOnceRetentionDays({}), 10)
  assert.deepEqual(createOncePolicy({}), { retentionSeconds: 10 * 24 * 60 * 60 })
})

test('create-once retention: env override accepts whole days 1-3650 only', () => {
  assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: '30' }), 30)
  assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: ' 1 ' }), 1)
  assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: '3650' }), 3650)
  for (const bad of ['0', '3651', '-1', '1.5', 'abc', '', '1e3']) {
    assert.equal(createOnceRetentionDays({ HITLY_CREATE_ONCE_RETENTION_DAYS: bad }), 10, bad)
  }
  assert.deepEqual(createOncePolicy({ HITLY_CREATE_ONCE_RETENTION_DAYS: '2' }), { retentionSeconds: 2 * 86400 })
})

test('create-once window boundary: the cutoff instant is outside, 1 ms later is inside', () => {
  const now = Date.UTC(2026, 10, 9, 12, 0, 0)
  const cutoff = createOnceCutoff(now, {})
  assert.equal(cutoff.getTime(), now - 10 * DAY)
  assert.equal(withinCreateOnceWindow(new Date(now - 10 * DAY), now, {}), false)
  assert.equal(withinCreateOnceWindow(new Date(now - 10 * DAY + 1), now, {}), true)
  assert.equal(withinCreateOnceWindow(new Date(now - 10 * DAY - 1), now, {}), false)
  assert.equal(withinCreateOnceWindow(new Date(now), now, {}), true)
  const env = { HITLY_CREATE_ONCE_RETENTION_DAYS: '1' }
  assert.equal(withinCreateOnceWindow(new Date(now - DAY + 1), now, env), true)
  assert.equal(withinCreateOnceWindow(new Date(now - DAY), now, env), false)
})
