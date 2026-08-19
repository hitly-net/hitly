import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAttentionLink, parsePushData } from './linking'

test('parseAttentionLink: hitly://inbox/apr_123', () => {
  const result = parseAttentionLink('hitly://inbox/apr_123')
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: undefined,
  })
})

test('parseAttentionLink: hitly://inbox/apr_123?host=localhost:3001', () => {
  const result = parseAttentionLink('hitly://inbox/apr_123?host=localhost:3001')
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: 'https://localhost:3001',
  })
})

test('parseAttentionLink: https://cloud.hitly.net/inbox/apr_123', () => {
  const result = parseAttentionLink('https://cloud.hitly.net/inbox/apr_123')
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: 'https://cloud.hitly.net',
  })
})

test('parseAttentionLink: https://cloud.hitly.net/inbox/apr_123?host=localhost:3001', () => {
  const result = parseAttentionLink('https://cloud.hitly.net/inbox/apr_123?host=localhost:3001')
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: 'https://localhost:3001',
  })
})

test('parseAttentionLink: https://example.com/inbox/apr_456', () => {
  const result = parseAttentionLink('https://example.com/inbox/apr_456')
  assert.deepEqual(result, {
    approvalId: 'apr_456',
    instanceUrl: 'https://example.com',
  })
})

test('parseAttentionLink: URL-encoded approval ID', () => {
  const result = parseAttentionLink('hitly://inbox/apr_%40123')
  assert.deepEqual(result, {
    approvalId: 'apr_@123',
    instanceUrl: undefined,
  })
})

test('parseAttentionLink: invalid URL returns null', () => {
  const result = parseAttentionLink('not a url')
  assert.equal(result, null)
})

test('parseAttentionLink: null returns null', () => {
  const result = parseAttentionLink(null)
  assert.equal(result, null)
})

test('parseAttentionLink: undefined returns null', () => {
  const result = parseAttentionLink(undefined)
  assert.equal(result, null)
})

test('parseAttentionLink: wrong path returns null', () => {
  const result = parseAttentionLink('hitly://wrong/apr_123')
  assert.equal(result, null)
})

test('parsePushData: approval type with approvalId', () => {
  const result = parsePushData({ type: 'approval', approvalId: 'apr_123' })
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: undefined,
  })
})

test('parsePushData: approval type with approvalId and instanceUrl', () => {
  const result = parsePushData({ type: 'approval', approvalId: 'apr_123', instanceUrl: 'https://cloud.hitly.net' })
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: 'https://cloud.hitly.net',
  })
})

test('parsePushData: instanceUrl normalization', () => {
  const result = parsePushData({ type: 'approval', approvalId: 'apr_123', instanceUrl: 'localhost:3001' })
  assert.deepEqual(result, {
    approvalId: 'apr_123',
    instanceUrl: 'https://localhost:3001',
  })
})

test('parsePushData: wrong type returns null', () => {
  const result = parsePushData({ type: 'other', approvalId: 'apr_123' })
  assert.equal(result, null)
})

test('parsePushData: missing approvalId returns null', () => {
  const result = parsePushData({ type: 'approval' })
  assert.equal(result, null)
})

test('parsePushData: non-string approvalId returns null', () => {
  const result = parsePushData({ type: 'approval', approvalId: 123 })
  assert.equal(result, null)
})

test('parsePushData: undefined returns null', () => {
  const result = parsePushData(undefined)
  assert.equal(result, null)
})
