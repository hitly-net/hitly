import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushCopy } from './push'

const NOW = new Date('2026-11-11T09:00:00Z')
const in24h = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)

test('ask_user push title is the question itself (no raw tool name)', () => {
  const copy = pushCopy({
    projectName: 'Weekend plans',
    envelope: { prompt: 'Which restaurant should I book?' },
    origin: { agentName: 'Weekend planner' },
    expiresAt: in24h,
    now: NOW,
  })
  assert.equal(copy.title, 'Which restaurant should I book?')
  assert.ok(!copy.title.includes('ask_user'))
  assert.equal(copy.body, 'Weekend plans · expires in 24h')
})

test('ask_user push title is trimmed and truncated like the email subject', () => {
  const longPrompt = `  ${'schedule the release '.repeat(20)}  `
  const copy = pushCopy({
    projectName: 'Release ops',
    envelope: { prompt: longPrompt },
    expiresAt: in24h,
    now: NOW,
  })
  assert.ok(!copy.title.startsWith(' ') && !copy.title.endsWith(' '), 'title must be trimmed')
  assert.equal(copy.title.length, 160, 'same 160-char cap as the email question')
  assert.ok(copy.title.endsWith('…'), 'truncation uses the same ellipsis as the email')
  assert.ok(!copy.title.includes('  '), 'whitespace collapsed like safeText')
})

test('request_approval push title is the action summary', () => {
  const copy = pushCopy({
    projectName: 'Payments',
    envelope: { metadata: { summary: 'Refund order #4410 above the manual limit' } },
    origin: { agentName: 'Support agent' },
    expiresAt: in24h,
    now: NOW,
  })
  assert.equal(copy.title, 'HITLy: Refund order #4410 above the manual limit')
  assert.ok(!copy.title.includes('request_approval'))
  assert.equal(copy.body, 'Payments · expires in 24h')
})

test('request_approval push title falls back to the branded project subject', () => {
  const copy = pushCopy({
    projectName: 'Payments',
    envelope: { metadata: { cb_auth_token: 'super-secret-callback' } },
    expiresAt: in24h,
    now: NOW,
  })
  // Metadata holds only credential-shaped keys: nothing from it may surface.
  assert.equal(copy.title, 'HITLy: Payments needs your decision')
  assert.ok(!copy.title.includes('super-secret-callback'))
  assert.ok(!copy.body.includes('super-secret-callback'))
})

test('push body uses the real expiry like the emails, and degrades gracefully', () => {
  const soon = pushCopy({
    projectName: 'Ops',
    envelope: null,
    expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    now: NOW,
  })
  assert.equal(soon.body, 'Ops · expires in 30m')
  const none = pushCopy({ projectName: null, envelope: null, expiresAt: null, now: NOW })
  assert.equal(none.body, 'A work item is waiting for you.')
  assert.equal(none.title, 'HITLy: a decision is waiting for you')
})

test('push copy never leaks planted secrets or raw tool names', () => {
  const copy = pushCopy({
    projectName: 'Secrets test',
    envelope: {
      prompt: 'Deploy the hotfix now?',
      metadata: { cb_auth_token: 'CANARY-CB-TOKEN', resumeToken: 'CANARY-RESUME' },
      args: { apiKey: 'CANARY-ARG-SECRET', name: 'request_approval' },
    },
    origin: {
      agentName: 'Release bot',
      resumeHandle: { url: 'https://internal.example/cb', secret: 'CANARY-ORIGIN-SECRET' },
    },
    expiresAt: in24h,
    now: NOW,
  })
  const flat = `${copy.title}\n${copy.body}`
  for (const canary of [
    'CANARY-CB-TOKEN',
    'CANARY-RESUME',
    'CANARY-ARG-SECRET',
    'CANARY-ORIGIN-SECRET',
    'internal.example',
  ]) {
    assert.ok(!flat.includes(canary), `push copy must not contain ${canary}`)
  }
  for (const tool of ['ask_user', 'request_approval']) {
    assert.ok(!flat.includes(tool), `push copy must not contain raw tool name ${tool}`)
  }
})
