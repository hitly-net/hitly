import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SUPPORT_TICKET_TYPES } from '@hitly/core'
import { createZammadClient } from '../src/client.ts'
import {
  ensureHitlyTypeField,
  hitlyTypeOptions,
  HITLY_TYPE_ATTRIBUTE,
  HITLY_TYPE_DISPLAY,
} from './setup-hitly-type-field.ts'

const BASE_URL = 'https://zammad.example.test'
const TOKEN = 'unit-test-token-not-a-secret'

interface RecordedCall {
  url: string
  method: string
  body: unknown
}

function makeClient(responses: unknown[]) {
  const calls: RecordedCall[] = []
  const logs: string[] = []
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    const index = Math.min(calls.length - 1, responses.length - 1)
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => responses[index],
    }
  }) as unknown as typeof globalThis.fetch
  const client = createZammadClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetch: fn,
    sleep: async () => {},
  })
  return { client, calls, logs }
}

const EXPECTED_OPTIONS: Record<string, string> = Object.fromEntries(
  SUPPORT_TICKET_TYPES.map((t) => [t.value, t.label]),
)

function ticketAttrs(extra: Record<string, unknown>[] = []) {
  return [
    { id: 1, object: 'Ticket', name: 'title', data_type: 'input', options: {} },
    { id: 2, object: 'Ticket', name: 'state_id', data_type: 'select', options: { open: 'Open' } },
    ...extra,
  ]
}

test('options map is derived from SUPPORT_TICKET_TYPES (one-line-addition contract)', () => {
  assert.deepEqual(hitlyTypeOptions(), EXPECTED_OPTIONS)
  assert.deepEqual(hitlyTypeOptions(), {
    billing: 'Billing',
    account: 'Account',
    data: 'Data',
    general: 'General',
    feature: 'Feature request',
    bug: 'Bug',
    security: 'Security/Abuse',
  })
})

test('absent attribute -> POST creates hitly_type select with all options', async () => {
  const { client, calls, logs } = makeClient([ticketAttrs()])
  const outcome = await ensureHitlyTypeField(client, (m) => logs.push(m))
  assert.equal(outcome, 'created')
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'GET')
  assert.ok(calls[0]!.url.includes('/api/v1/object_manager_attributes?object=Ticket'))
  assert.equal(calls[1]!.method, 'POST')
  assert.equal(calls[1]!.url, `${BASE_URL}/api/v1/object_manager_attributes`)
  assert.deepEqual(calls[1]!.body, {
    object: 'Ticket',
    name: HITLY_TYPE_ATTRIBUTE,
    display: HITLY_TYPE_DISPLAY,
    data_type: 'select',
    active: true,
    position: 999,
    options: EXPECTED_OPTIONS,
  })
  assert.ok(logs.some((m) => m.includes('created')))
})

test('existing attribute with DIFFERENT options -> PUT updates options only', async () => {
  const stale = { ...EXPECTED_OPTIONS, billing: 'Billing (old)', deprecated: 'Gone' }
  const { client, calls } = makeClient([
    ticketAttrs([{ id: 42, object: 'Ticket', name: HITLY_TYPE_ATTRIBUTE, data_type: 'select', options: stale }]),
  ])
  const outcome = await ensureHitlyTypeField(client, () => {})
  assert.equal(outcome, 'updated')
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.method, 'PUT')
  assert.equal(calls[1]!.url, `${BASE_URL}/api/v1/object_manager_attributes/42`)
  assert.deepEqual(calls[1]!.body, { options: EXPECTED_OPTIONS })
})

test('existing attribute with equal options -> NO write at all', async () => {
  const { client, calls } = makeClient([
    ticketAttrs([
      {
        id: 42,
        object: 'Ticket',
        name: HITLY_TYPE_ATTRIBUTE,
        data_type: 'select',
        // Same map, different key insertion order — equality is order-insensitive.
        options: Object.fromEntries(Object.entries(EXPECTED_OPTIONS).reverse()),
      },
    ]),
  ])
  const outcome = await ensureHitlyTypeField(client, () => {})
  assert.equal(outcome, 'unchanged')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'GET')
})

test('missing options map on existing attribute counts as differing -> PUT', async () => {
  const { client, calls } = makeClient([
    ticketAttrs([{ id: 7, object: 'Ticket', name: HITLY_TYPE_ATTRIBUTE, data_type: 'select' }]),
  ])
  const outcome = await ensureHitlyTypeField(client, () => {})
  assert.equal(outcome, 'updated')
  assert.equal(calls[1]!.method, 'PUT')
})

test('id-keyed object response shape is also accepted', async () => {
  const keyed = {
    '1': { id: 1, object: 'Ticket', name: 'title' },
    '42': { id: 42, object: 'Ticket', name: HITLY_TYPE_ATTRIBUTE, options: EXPECTED_OPTIONS },
  }
  const { client, calls } = makeClient([keyed])
  assert.equal(await ensureHitlyTypeField(client, () => {}), 'unchanged')
  assert.equal(calls.length, 1)
})

test('every run tells Ops to perform the Zammad migrate step', async () => {
  for (const responses of [
    [ticketAttrs()], // create path
    [ticketAttrs([{ id: 42, object: 'Ticket', name: HITLY_TYPE_ATTRIBUTE, options: {} }])], // update path
    [ticketAttrs([{ id: 42, object: 'Ticket', name: HITLY_TYPE_ATTRIBUTE, options: EXPECTED_OPTIONS }])], // no-op path
  ]) {
    const { client, logs } = makeClient(responses)
    await ensureHitlyTypeField(client, (m) => logs.push(m))
    assert.ok(
      logs.some((m) => /OPS/i.test(m) && /migrate/i.test(m)),
      'Ops migrate hint must be printed on every outcome',
    )
  }
})
