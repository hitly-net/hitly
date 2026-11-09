import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Ajv2020 from 'ajv/dist/2020'
import { argsHash, jcsHash, type ApprovalEnvelope } from '@hitly/core'
import { buildActivity, buildHitlRead, type DecisionRow } from './hitl-response'

const fixtures = new URL('../../../packages/core/src/fixtures/hitl-spec/', import.meta.url)
const responseSchema = JSON.parse(readFileSync(new URL('response.schema.json', fixtures), 'utf8'))
const eventSchema = JSON.parse(readFileSync(new URL('event.schema.json', fixtures), 'utf8'))
const ajv = new Ajv2020({ strict: false, allErrors: true })
// RFC 3339 date-time (the schemas' only format), without pulling in ajv-formats.
ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)))
ajv.addSchema(eventSchema)
const validate = ajv.compile(responseSchema)

function assertValid(value: unknown) {
  const ok = validate(value)
  assert.ok(ok, JSON.stringify(validate.errors, null, 2))
}

const ARGS = { amount: 100, currency: 'EUR', to: 'acct-1' }
const envelope = {
  action: { name: 'pay', args: ARGS },
  externalUrls: [{ ref: 'invoice', url: 'https://example.com/i/1', label: 'Invoice' }],
} as unknown as ApprovalEnvelope

const created = new Date('2026-11-09T10:00:00.000Z')
const presented = new Date('2026-11-09T10:01:00.000Z')
const decidedAt = new Date('2026-11-09T10:05:00.000Z')

function approval(status: string, extra: Partial<{ expiresAt: Date | null; presentedAt: Date | null }> = {}) {
  return { id: 'apr_1', status, createdAt: created, presentedAt: presented, expiresAt: null, ...extra }
}

function decision(d: DecisionRow['decision'], payload: Record<string, unknown> = {}, actor: string | null = 'usr_1'): DecisionRow {
  return { decision: d, payload: { decision: d, ...payload }, actorUserId: actor, createdAt: decidedAt }
}

test('hitl read: open request has no response yet, but argsHash and activity', async () => {
  const read = await buildHitlRead({ approval: approval('pending'), envelope, decision: null, opens: [] })
  assert.equal(read.hitl, null)
  assert.equal(read.state, 'pending')
  assert.equal(read.argsHash, await argsHash(ARGS))
  assert.match(read.argsHash, /^[A-Za-z0-9_-]{43}$/)
})

test('hitl read: accept -> answered/approve, schema-valid', async () => {
  const read = await buildHitlRead({ approval: approval('decided'), envelope, decision: decision('accept', { reason: 'ok' }), opens: [] })
  assertValid(read.hitl)
  assert.equal(read.hitl?.status, 'answered')
  assert.equal(read.hitl?.value, 'approve')
  assert.equal(read.hitl?.reason, 'ok')
  assert.deepEqual(read.hitl?.decidedBy, { kind: 'human', id: 'usr_1' })
  assert.equal(read.hitl?.decidedAt, decidedAt.toISOString())
  assert.equal(read.hitl?.signature, null)
  assert.equal(read.hitl?.argsHash, await argsHash(ARGS))
  assert.equal(read.hitl?._meta?.['net.hitly/decision'], 'accept')
  assert.equal('editedArgs' in read, false)
})

test('hitl read: reject -> answered/reject; respond -> answered with the reply; ignore -> declined', async () => {
  const reject = await buildHitlRead({ approval: approval('decided'), envelope, decision: decision('reject', { reason: 'no budget' }), opens: [] })
  assertValid(reject.hitl)
  assert.equal(reject.hitl?.value, 'reject')
  assert.equal(reject.hitl?.reason, 'no budget')

  const respond = await buildHitlRead({ approval: approval('decided'), envelope, decision: decision('respond', { response: 'Use the EUR account' }), opens: [] })
  assertValid(respond.hitl)
  assert.equal(respond.hitl?.status, 'answered')
  assert.equal(respond.hitl?.value, 'Use the EUR account')

  const ignore = await buildHitlRead({ approval: approval('decided'), envelope, decision: decision('ignore'), opens: [] })
  assertValid(ignore.hitl)
  assert.equal(ignore.hitl?.status, 'declined')
  assert.equal('value' in (ignore.hitl ?? {}), false)
})

test('hitl read: edit -> answered/approve; edited args only in the response, argsHash stays the original', async () => {
  const read = await buildHitlRead({
    approval: approval('decided'),
    envelope,
    decision: decision('edit', { editedArgs: { amount: 90 } }),
    opens: [],
    mergeEdits: (edited) => ({ ...ARGS, ...edited }),
  })
  assertValid(read.hitl)
  assert.equal(read.hitl?.value, 'approve')
  assert.deepEqual(read.editedArgs, { amount: 90, currency: 'EUR', to: 'acct-1' })
  assert.deepEqual(read.hitl?._meta?.['net.hitly/editedArgs'], read.editedArgs)
  assert.equal(read.hitl?._meta?.['net.hitly/editedArgsHash'], await jcsHash(read.editedArgs))
  assert.equal(read.argsHash, await argsHash(ARGS), 'argsHash covers the original request')
  assert.notEqual(read.hitl?._meta?.['net.hitly/editedArgsHash'], read.argsHash)
})

test('hitl read: cancel -> cancelled, says who withdrew it, no decidedBy', async () => {
  const byRequester = await buildHitlRead({
    approval: approval('cancelled'),
    envelope,
    decision: decision('cancel', { by: 'requester', requesterKeyId: 'key_1' }, null),
    opens: [],
  })
  assertValid(byRequester.hitl)
  assert.equal(byRequester.hitl?.status, 'cancelled')
  assert.equal(byRequester.hitl?._meta?.['net.hitly/cancelledBy'], 'requester')
  assert.equal(byRequester.hitl?.decidedBy, undefined)

  const byReviewer = await buildHitlRead({ approval: approval('cancelled'), envelope, decision: decision('cancel'), opens: [] })
  assertValid(byReviewer.hitl)
  assert.equal(byReviewer.hitl?._meta?.['net.hitly/cancelledBy'], 'reviewer')
})

test('hitl read: expired status and lazily expired pending -> expired, no decider', async () => {
  const expired = await buildHitlRead({ approval: approval('expired'), envelope, decision: null, opens: [] })
  assertValid(expired.hitl)
  assert.equal(expired.hitl?.status, 'expired')

  const lazy = await buildHitlRead({
    approval: approval('pending', { expiresAt: new Date('2026-11-09T11:00:00.000Z') }),
    envelope,
    decision: null,
    opens: [],
    now: Date.parse('2026-11-09T11:00:00.001Z'),
  })
  assertValid(lazy.hitl)
  assert.equal(lazy.state, 'expired')
  const notYet = await buildHitlRead({
    approval: approval('pending', { expiresAt: new Date('2026-11-09T11:00:00.000Z') }),
    envelope,
    decision: null,
    opens: [],
    now: Date.parse('2026-11-09T11:00:00.000Z'),
  })
  assert.equal(notYet.hitl, null)
})

test('hitl read: a decision whose reviewer account is gone still validates (service decider)', async () => {
  const read = await buildHitlRead({ approval: approval('decided'), envelope, decision: decision('accept', {}, null), opens: [] })
  assertValid(read.hitl)
  assert.equal(read.hitl?.decidedBy?.kind, 'service')
})

test('hitl read: activity lists each context item once with its opens, sha256 null', () => {
  const activity = buildActivity(envelope, null, [
    { itemRef: 'invoice', openedAt: '2026-11-09T10:03:00.000Z' },
    { itemRef: 'invoice', openedAt: '2026-11-09T10:02:00.000Z' },
    { itemRef: 'unknown', openedAt: '2026-11-09T10:02:00.000Z' },
  ])
  assert.equal(activity.presentedAt, null)
  assert.deepEqual(activity.items.filter((i) => i.ref === 'invoice'), [
    { ref: 'invoice', sha256: null, openedAt: ['2026-11-09T10:02:00.000Z', '2026-11-09T10:03:00.000Z'] },
  ])
  assert.equal(activity.items.some((i) => i.ref === 'unknown'), false)
})
