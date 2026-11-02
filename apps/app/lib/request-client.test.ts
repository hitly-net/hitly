/**
 * Unit tests for evidence `client` classification from request headers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clientFromHeaders, parseMobileClientHeader } from './request-client'

function headersInit(init: Record<string, string>): Headers {
  return new Headers(init)
}

test('cookie session (no bearer) is classified web', () => {
  const client = clientFromHeaders(headersInit({ cookie: 'session=abc', 'user-agent': 'Mozilla/5.0' }))
  assert.equal(client.channel, 'web')
  assert.equal(client.userAgent, 'Mozilla/5.0')
})

test('bearer + x-hitly-origin is classified mobile', () => {
  const client = clientFromHeaders(
    headersInit({ authorization: 'Bearer ***', 'x-hitly-origin': 'https://app.example.com' }),
  )
  assert.equal(client.channel, 'mobile')
})

test('x-hitly-client forces mobile and parses platform + appVersion', () => {
  const client = clientFromHeaders(
    headersInit({
      authorization: 'Bearer ***',
      'x-hitly-client': 'hitly-mobile/2.1.0 (ios)',
    }),
  )
  assert.equal(client.channel, 'mobile')
  assert.equal(client.platform, 'ios')
  assert.equal(client.appVersion, '2.1.0')
})

test('bare bearer without mobile headers is classified api', () => {
  const client = clientFromHeaders(headersInit({ authorization: 'Bearer ***' }))
  assert.equal(client.channel, 'api')
  assert.equal(client.platform, undefined)
})

test('malformed x-hitly-client is ignored (channel stays mobile via origin, fields unset)', () => {
  const client = clientFromHeaders(
    headersInit({
      authorization: 'Bearer ***',
      'x-hitly-origin': 'https://app.example.com',
      'x-hitly-client': 'total junk (((',
    }),
  )
  assert.equal(client.channel, 'mobile')
  assert.equal(client.platform, undefined)
  assert.equal(client.appVersion, undefined)
})

test('parseMobileClientHeader handles valid, version-only and junk values', () => {
  assert.deepEqual(parseMobileClientHeader('hitly-mobile/1.0.0 (android)'), {
    appVersion: '1.0.0',
    platform: 'android',
  })
  assert.deepEqual(parseMobileClientHeader('hitly-mobile/1.0.0'), { appVersion: '1.0.0' })
  assert.equal(parseMobileClientHeader('garbage'), undefined)
  assert.equal(parseMobileClientHeader(''), undefined)
  assert.equal(parseMobileClientHeader(null), undefined)
})

test('user-agent is truncated to 512 chars and control chars are stripped', () => {
  const long = 'a'.repeat(600)
  const client = clientFromHeaders(headersInit({ 'user-agent': long }))
  assert.equal(client.userAgent?.length, 512)

  // Real undici Headers reject control chars at construction, so exercise the
  // sanitizer with a Headers-like stub (what a lenient proxy could hand us).
  const stub = (values: Record<string, string>) =>
    ({ get: (name: string) => values[name.toLowerCase()] ?? null }) as unknown as Headers
  const control = clientFromHeaders(stub({ 'user-agent': 'Mozilla\u0000/5.0\u001F test' }))
  assert.equal(control.userAgent, 'Mozilla/5.0 test')

  const empty = clientFromHeaders(stub({ 'user-agent': '\u0000\u001F ' }))
  assert.equal(empty.userAgent, undefined)
})
