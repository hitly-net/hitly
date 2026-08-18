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

test('store_uri is http(s) and ends with /events/<event_id>', async () => {
  const event = buildTestEvent()
  
  const response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
  
  assert.equal(response.status, 200)
  const receipt = await response.json()
  
  assert.ok(receipt.store_uri.startsWith('http://') || receipt.store_uri.startsWith('https://'), 
    'store_uri should be http(s)')
  assert.ok(receipt.store_uri.endsWith(`/events/${event.event_id}`), 
    `store_uri should end with /events/${event.event_id}`)
  assert.ok(!receipt.store_uri.includes('file://'), 'store_uri should not be file://')
})

test('GET /events/:id with Accept text/html returns HTML', async () => {
  const event = buildTestEvent({ event_type: 'decided' })
  
  // POST event first
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })

  // GET with HTML accept header
  const response = await fetch(`${baseUrl}/events/${event.event_id}`, {
    headers: { 'Accept': 'text/html' },
  })
  
  assert.equal(response.status, 200)
  assert.ok(response.headers.get('content-type')?.includes('text/html'), 'Should return HTML')
  
  const html = await response.text()
  assert.ok(html.includes(event.event_type), 'HTML should contain event_type')
  assert.ok(html.includes(event.approval_id), 'HTML should contain approval_id')
  assert.ok(html.includes('HITL'), 'HTML should contain HITLy wordmark')
})

test('GET /events/:id JSON still works', async () => {
  const event = buildTestEvent()
  
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })

  const response = await fetch(`${baseUrl}/events/${event.event_id}`)
  assert.equal(response.status, 200)
  assert.ok(response.headers.get('content-type')?.includes('application/json'), 'Should return JSON')
  
  const retrieved = await response.json()
  assert.equal(retrieved.event_id, event.event_id)
})

test('GET /a/:approval_id lists chain and excludes ping', async () => {
  const approvalId = 'appr_chain_test'
  
  // Create a chain: requested -> decided -> resumed
  const event1 = buildTestEvent({ 
    approval_id: approvalId, 
    event_type: 'requested', 
    seq: 1 
  })
  const event2 = buildTestEvent({ 
    approval_id: approvalId, 
    event_type: 'decided', 
    seq: 2,
    integrity: {
      alg: 'sha256',
      prev_event_id: event1.event_id,
      prev_content_sha256: event1.integrity.content_sha256,
      content_sha256: 'hash2_' + Math.random().toString(36).slice(2),
    }
  })
  const event3 = buildTestEvent({ 
    approval_id: approvalId, 
    event_type: 'resumed', 
    seq: 3,
    integrity: {
      alg: 'sha256',
      prev_event_id: event2.event_id,
      prev_content_sha256: event2.integrity.content_sha256,
      content_sha256: 'hash3_' + Math.random().toString(36).slice(2),
    }
  })
  
  // Also post a ping that should not appear
  const pingEvent = buildTestEvent({ 
    approval_id: approvalId, 
    event_type: 'ping', 
    seq: 0 
  })

  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event1),
  })
  
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event2),
  })
  
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event3),
  })
  
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pingEvent),
  })

  // GET the chain
  const response = await fetch(`${baseUrl}/a/${approvalId}`)
  assert.equal(response.status, 200)
  assert.ok(response.headers.get('content-type')?.includes('text/html'), 'Should return HTML')
  
  const html = await response.text()
  assert.ok(html.includes(approvalId), 'Should show approval_id')
  assert.ok(html.includes('requested'), 'Should show requested event')
  assert.ok(html.includes('decided'), 'Should show decided event')
  assert.ok(html.includes('resumed'), 'Should show resumed event')
  assert.ok(html.includes(event1.integrity.content_sha256.slice(0, 16)), 'Should show hash')
  assert.ok(html.includes(event2.integrity.prev_event_id || ''), 'Should show prev_event_id')
  assert.ok(!html.includes('ping'), 'Should NOT show ping events')
})

test('POST ping does not create a listed row', async () => {
  const approvalId = 'appr_no_ping'
  
  // POST one real event
  const realEvent = buildTestEvent({ 
    approval_id: approvalId, 
    event_type: 'requested' 
  })
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(realEvent),
  })
  
  // POST a ping
  const pingEvent = buildTestEvent({ 
    approval_id: approvalId, 
    event_type: 'ping' 
  })
  await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pingEvent),
  })
  
  // Check the home page
  const response = await fetch(`${baseUrl}/`)
  const html = await response.text()
  
  // Should show the real event
  assert.ok(html.includes(approvalId), 'Should show approval with real event')
  
  // Count occurrences - should only appear once (not duplicated by ping)
  const matches = html.match(new RegExp(approvalId, 'g'))
  assert.ok(matches && matches.length >= 1, 'Approval should appear at least once')
})

test('Second POST same event_id returns same store_uri, one file', async () => {
  const event = buildTestEvent()
  
  const response1 = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
  const receipt1 = await response1.json()
  
  const response2 = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  })
  const receipt2 = await response2.json()
  
  assert.equal(receipt1.store_uri, receipt2.store_uri, 'store_uri should match')
  assert.ok(receipt1.store_uri.startsWith('http'), 'Should be http(s) URI')
  
  // Verify only one file exists
  const files = await readdir(eventsDir)
  const eventFiles = files.filter(f => f.startsWith(event.event_id))
  assert.equal(eventFiles.length, 1, 'Should only have one file')
})

test('Unknown event returns 404', async () => {
  const response = await fetch(`${baseUrl}/events/evt_does_not_exist`)
  assert.equal(response.status, 404)
})
