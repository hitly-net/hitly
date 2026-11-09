import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { argsHash, jcs } from './jcs.ts'

test('JCS sorts keys, drops whitespace and follows ES number form (RFC 8785)', () => {
  assert.equal(jcs({ b: 1, a: [true, null, 'x'], c: { z: 1e21, y: 0.1, x: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"x":0,"y":0.1,"z":1e+21}}')
  // UTF-16 code unit ordering, as RFC 8785 3.2.3 requires.
  assert.equal(jcs({ '\u20ac': 1, '\r': 2, '1': 3, 'é': 4 }), '{"\\r":2,"1":3,"é":4,"€":1}')
  assert.equal(jcs('\u2028'), '"\u2028"')
  assert.throws(() => jcs(Number.NaN), /non-finite/)
})

test('argsHash is b64url(SHA-256(JCS(args)))', () => {
  const expected = createHash('sha256').update('{"amount":40,"orderId":"1234"}', 'utf8').digest('base64url')
  assert.equal(argsHash({ orderId: '1234', amount: 40 }), expected)
  assert.equal(argsHash({ amount: 40, orderId: '1234' }), expected)
  assert.doesNotMatch(expected, /[+/=]/)
})
