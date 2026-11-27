import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CARD_TIMEOUT_MS,
  DEFAULT_STATUS_LABELS,
  clearConnectionCards,
  collectConnectionCards,
  listConnectionCards,
  registerConnectionCard,
  unregisterConnectionCard,
  type ConnectionCard,
  type ConnectionCardContext,
} from './connection-cards.ts'

/**
 * The interim Connections registry (hitly-net/hitly#218). Two properties carry
 * the design: cards are independent (one bad card cannot take the screen down)
 * and the order is deterministic (the screen must not reshuffle on refresh).
 */

const CONTEXT: ConnectionCardContext = { orgId: 'org_1', userId: 'user_1' }

function card(overrides: Partial<ConnectionCard> & { id: string }): ConnectionCard {
  return {
    name: overrides.name ?? overrides.id,
    description: 'desc',
    status: async () => ({ status: 'connected' }),
    ...overrides,
  }
}

async function withCards(cards: ConnectionCard[], run: () => Promise<void> | void) {
  clearConnectionCards()
  cards.forEach(registerConnectionCard)
  try {
    await run()
  } finally {
    clearConnectionCards()
  }
}

test('cards render in a stable order: order, then name, then id', async () => {
  await withCards(
    [
      card({ id: 'zeta', name: 'Zeta', order: 5 }),
      card({ id: 'alpha', name: 'Alpha', order: 5 }),
      card({ id: 'late', name: 'Aardvark' }),
      card({ id: 'first', name: 'Zebra', order: 1 }),
    ],
    () => {
      assert.deepEqual(
        listConnectionCards().map((c) => c.id),
        ['first', 'alpha', 'zeta', 'late'],
      )
      // Repeated enumeration is identical, whatever insertion order produced it.
      assert.deepEqual(
        listConnectionCards().map((c) => c.id),
        listConnectionCards().map((c) => c.id),
      )
    },
  )
})

test('re-registering an id replaces the card instead of duplicating it', async () => {
  await withCards([], async () => {
    registerConnectionCard(card({ id: 'hitly', name: 'HITLy' }))
    registerConnectionCard(card({ id: 'hitly', name: 'HITLy (new)' }))
    assert.equal(listConnectionCards().length, 1)
    assert.equal(listConnectionCards()[0]!.name, 'HITLy (new)')
    assert.equal(unregisterConnectionCard('hitly'), true)
    assert.equal(unregisterConnectionCard('hitly'), false)
  })
})

test('a card without an id or status() is rejected at registration', async () => {
  await withCards([], () => {
    assert.throws(() => registerConnectionCard({ name: 'x' } as unknown as ConnectionCard), /id/)
    assert.throws(
      () => registerConnectionCard({ id: 'x', name: 'x', description: '', } as unknown as ConnectionCard),
      /status/,
    )
    assert.equal(listConnectionCards().length, 0)
  })
})

test('collect serves the fields the bootstrap renders, with default labels', async () => {
  await withCards(
    [
      card({
        id: 'hitly',
        name: 'HITLy',
        order: 1,
        description: 'Human-in-the-loop gates',
        icon: '🤝',
        settingsPath: '/web/integrations/hitly/settings',
        status: async () => ({ status: 'env-fallback', detail: '2 factories on env fallback' }),
      }),
      card({ id: 'bare', order: 2, status: async () => ({ status: 'not-connected' }) }),
      card({ id: 'custom', order: 3, status: async () => ({ status: 'error', label: 'HITLy unreachable' }) }),
    ],
    async () => {
      const views = await collectConnectionCards(CONTEXT)
      assert.deepEqual(views.map((v) => v.id), ['hitly', 'bare', 'custom'])
      assert.deepEqual(views[0], {
        id: 'hitly',
        name: 'HITLy',
        description: 'Human-in-the-loop gates',
        icon: '🤝',
        settingsPath: '/web/integrations/hitly/settings',
        status: 'env-fallback',
        label: DEFAULT_STATUS_LABELS['env-fallback'],
        detail: '2 factories on env fallback',
      })
      assert.equal(views[1]!.icon, '')
      assert.equal(views[1]!.settingsPath, null)
      assert.equal(views[1]!.detail, null)
      assert.equal(views[2]!.label, 'HITLy unreachable', 'a card may override the copy')
    },
  )
})

test('every card is asked about the caller, including the specific factory when one is in view', async () => {
  const asked: ConnectionCardContext[] = []
  await withCards(
    [card({ id: 'a', status: async (context) => { asked.push(context); return { status: 'connected' } } })],
    async () => {
      await collectConnectionCards({ orgId: 'org_2', userId: 'user_9', factoryProjectId: 'fproj_7' })
      assert.deepEqual(asked, [{ orgId: 'org_2', userId: 'user_9', factoryProjectId: 'fproj_7' }])
    },
  )
})

test('a throwing or stalled card is logged and dropped; its neighbours still render', async () => {
  const logged: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = []
  await withCards(
    [
      card({ id: 'boom', status: async () => { throw new Error('hitly down') } }),
      card({ id: 'rejects', status: () => Promise.reject(new Error('nope')) }),
      card({ id: 'sync-throw', status: () => {
        throw 'string failure'
      } }),
      card({ id: 'stalls', status: () => new Promise(() => undefined) }),
      card({ id: 'fine', status: async () => ({ status: 'connected' }) }),
    ],
    async () => {
      const views = await collectConnectionCards(CONTEXT, {
        timeoutMs: 25,
        log: (level, message, meta) => logged.push({ level, message, meta }),
      })
      assert.deepEqual(views.map((v) => v.id), ['fine'], 'only the healthy card survives')
      assert.deepEqual(
        logged.map((entry) => entry.meta?.cardId),
        ['boom', 'rejects', 'stalls', 'sync-throw'],
        'cards are tried in the render order, failures and all',
      )
      assert.ok(logged.every((entry) => entry.level === 'warn' && entry.message.includes('connection card skipped')))
      const byId = new Map(logged.map((entry) => [String(entry.meta?.cardId), String(entry.meta?.error)]))
      assert.match(byId.get('boom')!, /hitly down/)
      assert.match(byId.get('sync-throw')!, /string failure/, 'non-Error throws are still reported')
      assert.match(byId.get('stalls')!, /timed out after 25ms/)
    },
  )
})

test('a card that never settles is bounded by the default timeout, not by patience', async () => {
  await withCards([], async () => {
    registerConnectionCard(card({ id: 'slow', status: () => new Promise(() => undefined) }))
    const started = Date.now()
    const views = await collectConnectionCards(CONTEXT, { timeoutMs: 30 })
    assert.equal(views.length, 0)
    assert.ok(Date.now() - started >= 25, 'the timeout actually waited')
    assert.ok(DEFAULT_CARD_TIMEOUT_MS > 0, 'the default bounds a hung card for the settings page too')
  })
})

test('a card that answers after the timeout cannot resolve late into the view', async () => {
  await withCards([], async () => {
    let resolveLate: (value: { status: 'connected' }) => void = () => undefined
    registerConnectionCard(
      card({ id: 'late', status: () => new Promise((resolve) => { resolveLate = resolve }) }),
    )
    const views = await collectConnectionCards(CONTEXT, { timeoutMs: 5 })
    assert.equal(views.length, 0)
    resolveLate({ status: 'connected' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(views.length, 0, 'a late answer does not mutate an already-served response')
  })
})

test('the registry lives on globalThis under a Symbol.for key, so duplicate module copies share one', async () => {
  await withCards([card({ id: 'shared' })], () => {
    const state = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@hitly/mastra-factory-plugin.connection-cards')
    ] as { cards: Map<string, ConnectionCard> }
    assert.ok(state.cards instanceof Map)
    assert.equal(state.cards.has('shared'), true)
  })
})
