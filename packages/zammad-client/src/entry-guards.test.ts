/**
 * Entry-point guard: the main export of @hitly/zammad-client must NEVER
 * expose publishing or live-answer editing. If this test goes red, someone
 * moved publisher surface into the safe entry — move it back.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as mainEntry from './index.ts'
import * as publisherEntry from './publisher.ts'
import { createZammadClient } from './client.ts'

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

/** The COMPLETE method surface of the safe client — extend deliberately. */
const SAFE_CLIENT_METHODS = [
  'addInternalNote',
  'addPublicEmailReply',
  'getTicket',
  'kbCreateDraftAnswer',
  'kbGetAnswer',
  'kbSearch',
  'listArticles',
  'rawRequest',
  'searchTickets',
  'updateTicket',
]

test('main entry exports contain no publish/live-edit names (runtime check)', () => {
  const exported = Object.keys(mainEntry).sort()
  for (const forbidden of ['publishAnswer', 'updateLiveAnswer', 'createZammadPublisher', 'sha256Hex']) {
    assert.ok(!exported.includes(forbidden), `main entry must not export ${forbidden}, got ${exported.join(', ')}`)
  }
  // Positive control: the publisher entry does export the restricted surface.
  assert.equal(typeof publisherEntry.createZammadPublisher, 'function')
  const publisher = publisherEntry.createZammadPublisher({
    baseUrl: 'https://zammad.example.test',
    token: 'x',
    fetch: (async () => {
      throw new Error('must not fetch')
    }) as unknown as typeof globalThis.fetch,
  })
  assert.equal(typeof publisher.publishAnswer, 'function')
  assert.equal(typeof publisher.updateLiveAnswer, 'function')
})

test('safe client method surface is EXACTLY the allowlist (deepEqual pin)', () => {
  const client = createZammadClient({
    baseUrl: 'https://zammad.example.test',
    token: 'x',
    fetch: (async () => {
      throw new Error('must not fetch')
    }) as unknown as typeof globalThis.fetch,
  })
  assert.deepEqual(Object.keys(client).sort(), [...SAFE_CLIENT_METHODS].sort())
})

test('no method name on the safe client smells of publish/live-edit', () => {
  const client = createZammadClient({
    baseUrl: 'https://zammad.example.test',
    token: 'x',
    fetch: (async () => {
      throw new Error('must not fetch')
    }) as unknown as typeof globalThis.fetch,
  })
  for (const name of Object.keys(client)) {
    assert.ok(
      !/publish/i.test(name),
      `safe client must not grow a publish-like method: ${name}`,
    )
    assert.ok(
      !/updateLiveAnswer|editAnswer|updateAnswer/i.test(name),
      `safe client must not grow a live-answer-edit method: ${name}`,
    )
  }
})

test('source scan: index.ts never mentions the restricted names or imports publisher', () => {
  const source = read('./index.ts')
  for (const forbidden of ['publishAnswer', 'updateLiveAnswer', 'createZammadPublisher', './publisher']) {
    assert.ok(!source.includes(forbidden), `index.ts must not contain ${forbidden}`)
  }
})

test('source scan: no main-path module (client/request/types/errors) exports the restricted functions', () => {
  for (const file of ['./client.ts', './request.ts', './types.ts', './errors.ts']) {
    const source = read(file)
    for (const forbidden of ['export function publishAnswer', 'export function updateLiveAnswer', 'export async function publishAnswer', 'export async function updateLiveAnswer']) {
      assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`)
    }
  }
})

test('source scan: publisher.ts is the only home of the restricted functions', () => {
  const source = read('./publisher.ts')
  assert.match(source, /async function publishAnswer|publishAnswer\(kbId/)
  assert.match(source, /async function updateLiveAnswer|updateLiveAnswer\(\s*kbId/)
})
