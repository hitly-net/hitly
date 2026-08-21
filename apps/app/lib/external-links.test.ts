/**
 * Tests for externalUrls with optional labels.
 * Run with: yarn test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeExternalLinks, type ExternalLink } from '@hitly/core'
import { httpPlugin } from '@hitly/plugin-http'
import { mastraPlugin } from '@hitly/plugin-mastra'

test('normalizeExternalLinks handles string arrays', () => {
  const input = ['https://example.com/order/123', 'https://example.com/ticket/456']
  const result = normalizeExternalLinks(input)
  assert.deepEqual(result, [
    { url: 'https://example.com/order/123' },
    { url: 'https://example.com/ticket/456' },
  ])
})

test('normalizeExternalLinks handles ExternalLink objects', () => {
  const input: ExternalLink[] = [
    { url: 'https://example.com/order/123', label: 'Order #123' },
    { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
  ]
  const result = normalizeExternalLinks(input)
  assert.deepEqual(result, [
    { url: 'https://example.com/order/123', label: 'Order #123' },
    { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
  ])
})

test('normalizeExternalLinks handles mixed arrays', () => {
  const input: Array<string | ExternalLink> = [
    'https://example.com/order/123',
    { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
    { url: 'https://example.com/policy/789' },
  ]
  // Type cast needed because normalizeExternalLinks expects homogeneous arrays at the API boundary
  const result = normalizeExternalLinks(input as unknown as string[] | ExternalLink[])
  assert.deepEqual(result, [
    { url: 'https://example.com/order/123' },
    { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
    { url: 'https://example.com/policy/789' },
  ])
})

test('normalizeExternalLinks filters empty URLs and trims', () => {
  const input: Array<string | ExternalLink> = [
    '  https://example.com/order/123  ',
    { url: '  https://example.com/ticket/456  ', label: '  Support Ticket  ' },
    '',
    { url: '', label: 'Empty URL' },
    { url: '   ', label: 'Whitespace URL' },
  ]
  // Type cast needed because normalizeExternalLinks expects homogeneous arrays at the API boundary
  const result = normalizeExternalLinks(input as unknown as string[] | ExternalLink[])
  assert.deepEqual(result, [
    { url: 'https://example.com/order/123' },
    { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
  ])
})

test('normalizeExternalLinks handles undefined and empty arrays', () => {
  assert.deepEqual(normalizeExternalLinks(undefined), [])
  assert.deepEqual(normalizeExternalLinks([]), [])
})

test('HTTP plugin ingest accepts externalUrls with labels', () => {
  const body = {
    resumeUrl: 'https://example.com/resume',
    runId: 'run-123',
    projectId: 'proj-456',
    actionName: 'test-action',
    args: { amount: 100 },
    externalUrls: [
      'https://example.com/order/123',
      { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
    ],
  }

  const result = httpPlugin.ingest(body)
  assert.ok(result.externalUrls)
  assert.equal(result.externalUrls.length, 2)
  assert.deepEqual(result.externalUrls[0], { url: 'https://example.com/order/123' })
  assert.deepEqual(result.externalUrls[1], { url: 'https://example.com/ticket/456', label: 'Support Ticket' })
})

test('Mastra plugin ingest accepts externalUrls with labels in suspendPayload', () => {
  const body = {
    plugin: 'mastra' as const,
    projectId: 'proj-456',
    runId: 'run-123',
    agentId: 'test-agent',
    stepId: 'step-1',
    action: { name: 'test-action', args: { amount: 100 } },
    suspendPayload: {
      reason: 'Test reason',
      externalUrls: [
        'https://example.com/order/123',
        { url: 'https://example.com/ticket/456', label: 'Support Ticket' },
      ],
    },
    mastraBaseUrl: 'http://localhost:4111',
  }

  const result = mastraPlugin.ingest(body)
  assert.ok(result.externalUrls)
  assert.equal(result.externalUrls.length, 2)
  assert.deepEqual(result.externalUrls[0], { url: 'https://example.com/order/123' })
  assert.deepEqual(result.externalUrls[1], { url: 'https://example.com/ticket/456', label: 'Support Ticket' })
})

test('Mastra plugin ingest accepts externalUrls with labels in body', () => {
  const body = {
    plugin: 'mastra' as const,
    projectId: 'proj-456',
    runId: 'run-123',
    agentId: 'test-agent',
    stepId: 'step-1',
    action: { name: 'test-action', args: { amount: 100 } },
    suspendPayload: {
      reason: 'Test reason',
    },
    externalUrls: [
      { url: 'https://example.com/policy/789', label: 'Refund Policy' },
    ],
    mastraBaseUrl: 'http://localhost:4111',
  }

  const result = mastraPlugin.ingest(body)
  assert.ok(result.externalUrls)
  assert.equal(result.externalUrls.length, 1)
  assert.deepEqual(result.externalUrls[0], { url: 'https://example.com/policy/789', label: 'Refund Policy' })
})
