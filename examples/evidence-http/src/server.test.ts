/**
 * Tests for the reference HTTP evidence receiver
 * Run with: yarn test
 */

import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { createEvidenceServer } from './server.js'
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

let server: Server
let baseUrl: string
let eventsDir: string
let originalEventsDir: string | undefined

before(async () => {
  // Create temp directory for test events
  eventsDir = await mkdtemp(join(tmpdir(), 'evidence-http-test-'))
  originalEventsDir = process.env.EVENTS_DIR

  // Create server on ephemeral port with test events dir
  server = createEvidenceServer(eventsDir)
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      baseUrl = `http://localhost:${port}`
      console.log(`[test] Server listening on ${baseUrl}`)
      resolve()
    })
  })
})

after(async () => {
  // Close server
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        console.log('[test] Server closed')
        resolve()
      })
    })
  }

  // Clean up temp directory
  if (eventsDir) {
    await rm(eventsDir, { recursive: true, force: true })
  }

  // Restore original EVENTS_DIR
  if (originalEventsDir !== undefined) {
    process.env.EVENTS_DIR = originalEventsDir
  } else {
    delete process.env.EVENTS_DIR
  }
})

function buildTestEvent(overrides?: Partial<any>): any {
  return {
    spec: 'hitly.evidence.v1',
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    approval_id: 'appr_test123',
    event_type: 'requested',
    seq: 1,
    occurred_at: new Date().toISOString(),
    origin: { plugin: 'mastra', projectId: 'prj_test', runId: 'run_test' },
    system: { systemId: 'test-system', inventoryId: 'inv-test' },
    policy: { policyId: 'pol-test', riskTier: 'medium' },
    action: { name: 'test_action', args: { test: true }, proposed_sha256: 'abc123' },
    retention: { min_days: 180 },
    integrity: {
      alg: 'sha256',
      content_sha256: 'test_hash_' + Math.random().toString(36).slice(2),
    },
    ...overrides,
  }
}

test('POST /events writes file and returns receipt', async () => {
  const event = buildTestEvent()
  
  const response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })

  assert.equal(response.status, 200, 'Should return 200')
  const receipt = await response.json()

  assert.equal(receipt.event_id, event.event_id, 'Receipt event_id should match')
  assert.equal(receipt.content_sha256, event.integrity.content_sha256, 'Receipt hash should match event')
  assert.ok(receipt.store_uri.includes(event.event_id), 'Store URI should include event_id')
  assert.ok(receipt.stored_at, 'Should have stored_at timestamp')

  // Verify file was written
  const filePath = join(eventsDir, `${event.event_id}.json`)
  const fileContent = await readFile(filePath, 'utf8')
  const storedEvent = JSON.parse(fileContent)
  assert.equal(storedEvent.event_id, event.event_id, 'Stored event_id should match')
  assert.equal(storedEvent.integrity.content_sha256, event.integrity.content_sha256, 'Stored hash should match')
})

test('Same event_id is idempotent (no fork)', async () => {
  const event = buildTestEvent()
  
  // First POST
  const response1 = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event.event_id },
    body: JSON.stringify(event),
  })
  assert.equal(response1.status, 200)
  const receipt1 = await response1.json()

  // Second POST with same event_id
  const response2 = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': event.event_id },
    body: JSON.stringify(event),
  })
  assert.equal(response2.status, 200)
  const receipt2 = await response2.json()

  // Should return same receipt
  assert.equal(receipt2.event_id, receipt1.event_id, 'Event ID should match')
  assert.equal(receipt2.content_sha256, receipt1.content_sha256, 'Hash should match')
  assert.equal(receipt2.store_uri, receipt1.store_uri, 'Store URI should match')

  // Should only have one file
  const files = await readdir(eventsDir)
  const eventFiles = files.filter(f => f.startsWith(event.event_id))
  assert.equal(eventFiles.length, 1, 'Should only have one file for this event_id')
})

test('Ping writes nothing', async () => {
  const filesBefore = await readdir(eventsDir)
  
  // Test event_type: ping
  const pingEvent = buildTestEvent({ event_type: 'ping' })
  const response1 = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pingEvent),
  })
  assert.equal(response1.status, 200)
  const body1 = await response1.json()
  assert.ok(body1.ok || body1.message, 'Should return ok/message for ping')

  // Test x-hitly-ping header
  const normalEvent = buildTestEvent()
  const response2 = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hitly-ping': 'true' },
    body: JSON.stringify(normalEvent),
  })
  assert.equal(response2.status, 200)

  // No new files should be created
  const filesAfter = await readdir(eventsDir)
  assert.equal(filesAfter.length, filesBefore.length, 'Ping should not create files')
})

test('Disk failure returns 5xx', { timeout: 5000 }, async () => {
  // Create a new server with a file (not directory) as EVENTS_DIR
  const badPath = join(eventsDir, 'bad_events_dir_file')
  await writeFile(badPath, 'not a directory', 'utf8')
  
  const badServer = createEvidenceServer(badPath)
  const port = await new Promise<number>((resolve) => {
    badServer.listen(0, () => {
      const addr = badServer.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
  
  const badUrl = `http://localhost:${port}`

  try {
    const event = buildTestEvent()
    const response = await fetch(`${badUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })

    assert.ok(response.status >= 500 && response.status < 600, `Should return 5xx, got ${response.status}`)
  } finally {
    // Always close bad server
    await new Promise<void>((resolve) => badServer.close(() => resolve()))
  }
})

test('GET /events/:id returns stored event', async () => {
  const event = buildTestEvent()
  
  // POST event
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })

  // GET event
  const response = await fetch(`${baseUrl}/events/${event.event_id}`)
  assert.equal(response.status, 200)
  
  const retrieved = await response.json()
  assert.equal(retrieved.event_id, event.event_id, 'Retrieved event_id should match')
  assert.equal(retrieved.integrity.content_sha256, event.integrity.content_sha256, 'Retrieved hash should match')
})

test('GET /events/:id returns 404 for missing event', async () => {
  const response = await fetch(`${baseUrl}/events/evt_nonexistent`)
  assert.equal(response.status, 404)
})

test('Evidence fields are stored (systemId, inventoryId, policyId, riskTier)', async () => {
  const event = buildTestEvent({
    system: { systemId: 'payment-agent-prod', inventoryId: 'ai-inv-payment-v1' },
    policy: { policyId: 'payment-approval-required', riskTier: 'high' },
  })
  
  const response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
  assert.equal(response.status, 200)

  // Read file and verify fields
  const filePath = join(eventsDir, `${event.event_id}.json`)
  const fileContent = await readFile(filePath, 'utf8')
  const storedEvent = JSON.parse(fileContent)
  
  assert.equal(storedEvent.system.systemId, 'payment-agent-prod', 'systemId should be stored')
  assert.equal(storedEvent.system.inventoryId, 'ai-inv-payment-v1', 'inventoryId should be stored')
  assert.equal(storedEvent.policy.policyId, 'payment-approval-required', 'policyId should be stored')
  assert.equal(storedEvent.policy.riskTier, 'high', 'riskTier should be stored')
})
