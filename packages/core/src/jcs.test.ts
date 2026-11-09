import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { canonicalJson, hashActionArgs } from './evidence.ts'
import { argsHash, eventHash, jcs, jcsHash, sha256B64url } from './jcs.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/hitl-spec/${name}`, import.meta.url), 'utf8'))

type ArgsVector = { name: string; args: Record<string, unknown>; jcs: string; argsHash: string }

test('hitl-spec 3.8 argsHash vectors: JCS text and b64url SHA-256 match', async () => {
  const vectors = fixture('args-hash.json') as ArgsVector[]
  assert.ok(vectors.length >= 2)
  for (const vector of vectors) {
    assert.equal(jcs(vector.args), vector.jcs, `${vector.name} JCS`)
    assert.equal(await argsHash(vector.args), vector.argsHash, `${vector.name} argsHash`)
  }
})

test('hitl-spec 5.4 event chain vectors: each hash is the JCS hash without `hash`, chained by prevHash', async () => {
  const events = fixture('event-chain.json') as Array<Record<string, unknown>>
  assert.ok(events.length >= 2)
  let prev: unknown = null
  for (const event of events) {
    assert.equal(event.prevHash, prev, `${String(event.id)} prevHash`)
    assert.equal(await eventHash(event), event.hash, `${String(event.id)} hash`)
    prev = event.hash
  }
})

test('JCS sorts members by UTF-16 code units (RFC 8785 3.2.3 example)', () => {
  const input = {
    '\u20ac': 'Euro Sign',
    '\r': 'Carriage Return',
    '\ufb33': 'Hebrew Letter Dalet With Dagesh',
    '1': 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face',
    '\u0080': 'Control',
    '\u00f6': 'Latin Small Letter O With Diaeresis',
  }
  // Read the order from the text: JSON.parse would move the integer-like key "1" first.
  const expected =
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
    '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}'
  assert.equal(jcs(input), expected)
})

test('JCS number and string forms (RFC 8785 3.2.2)', () => {
  assert.equal(jcs({ n: [0, -0, 1e21, 1e-7, 333333333.33333329, 4.5, 2e-3, 1e+30, -1e-27] }), '{"n":[0,0,1e+21,1e-7,333333333.3333333,4.5,0.002,1e+30,-1e-27]}')
  assert.equal(jcs({ s: '\u000f\n"\\/\u2028\u00e9' }), '{"s":"\\u000f\\n\\"\\\\/\u2028\u00e9"}')
  assert.equal(jcs({ b: [true, false, null] }), '{"b":[true,false,null]}')
  assert.equal(jcs({ d: new Date('2026-11-09T12:00:00.000Z') }), '{"d":"2026-11-09T12:00:00.000Z"}')
})

test('JCS refuses values JSON cannot carry instead of dropping them', () => {
  assert.throws(() => jcs({ a: undefined }), /unsupported undefined/)
  assert.throws(() => jcs({ a: Number.NaN }), /non-finite/)
  assert.throws(() => jcs({ a: Infinity }), /non-finite/)
  assert.throws(() => jcs({ a: 1n }), /unsupported bigint/)
  assert.throws(() => jcs({ a: '\ud800' }), /lone surrogate/)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.throws(() => jcs(cyclic), /cycle/)
  // Shared (non-cyclic) references are fine.
  const shared = { x: 1 }
  assert.equal(jcs({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}')
})

test('argsHash is independent of key order and nesting order', async () => {
  const a = await argsHash({ b: 1, a: { d: [1, 2], c: 'x' } })
  const b = await argsHash({ a: { c: 'x', d: [1, 2] }, b: 1 })
  assert.equal(a, b)
  assert.match(a, /^[A-Za-z0-9_-]{43}$/)
})

test('for plain JSON args the JCS text equals the legacy canonicalJson text; only the encoding differs (hex vs b64url)', async () => {
  const vectors = fixture('args-hash.json') as ArgsVector[]
  for (const vector of vectors) {
    assert.equal(canonicalJson(vector.args), vector.jcs)
    const hex = await hashActionArgs(vector.args)
    assert.equal(Buffer.from(hex, 'hex').toString('base64url'), vector.argsHash)
  }
})

test('sha256B64url and jcsHash', async () => {
  assert.equal(await sha256B64url(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  assert.equal(await jcsHash({}), await sha256B64url('{}'))
})
