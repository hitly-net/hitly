import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { clearSentMail, resolveTransportName, sendMail, sentMail } from './index'

const keys = [
  'HITLY_MAIL_TRANSPORT',
  'HITLY_MAIL_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'RESEND_API_KEY',
] as const

const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
  clearSentMail()
})

test('explicit transport wins', () => {
  process.env.HITLY_MAIL_TRANSPORT = 'memory'
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.RESEND_API_KEY = 're_test'
  assert.equal(resolveTransportName(), 'memory')
})

test('SMTP_HOST wins over RESEND_API_KEY when transport is unset', () => {
  delete process.env.HITLY_MAIL_TRANSPORT
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.RESEND_API_KEY = 're_test'
  assert.equal(resolveTransportName(), 'smtp')
})

test('RESEND_API_KEY selects resend when SMTP_HOST is absent', () => {
  delete process.env.HITLY_MAIL_TRANSPORT
  delete process.env.SMTP_HOST
  process.env.RESEND_API_KEY = 're_test'
  assert.equal(resolveTransportName(), 'resend')
})

test('defaults to console', () => {
  delete process.env.HITLY_MAIL_TRANSPORT
  delete process.env.SMTP_HOST
  delete process.env.RESEND_API_KEY
  assert.equal(resolveTransportName(), 'console')
})

test('memory transport records messages', async () => {
  process.env.HITLY_MAIL_TRANSPORT = 'memory'
  process.env.HITLY_MAIL_FROM = 'Hitly Test <noreply@hitly.net>'
  const result = await sendMail({
    to: 'alex@example.com',
    subject: 'Reset your password',
    text: 'https://example.test/reset',
  })
  assert.deepEqual(result, { delivered: true })
  assert.equal(sentMail.length, 1)
  assert.equal(sentMail[0]?.to, 'alex@example.com')
  assert.equal(sentMail[0]?.from, 'Hitly Test <noreply@hitly.net>')
})
