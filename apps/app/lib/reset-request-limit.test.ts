import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailAndPasswordOptions } from './auth-email-password'
import {
  RESET_EMAIL_LIMIT,
  RESET_EMAIL_LIMITED_LOG,
  RESET_EMAIL_WINDOW_MS,
  createResetEmailLimiter,
  limitResetEmails,
  resetEmailKey,
} from './reset-request-limit'

/**
 * Per-account limit on password reset emails (lib/reset-request-limit.ts,
 * wired in lib/auth-email-password.ts).
 */

const APP_URL = 'http://localhost:3001'
const EMAIL = 'alex@example.com'

describe('reset email limiter', () => {
  it('sends up to the limit per account, then skips with a value-free log line', async () => {
    let time = 0
    const sent: string[] = []
    const logs: string[] = []
    const send = limitResetEmails(
      async ({ user, token }: { user: { email: string }; token: string }) => {
        sent.push(`${user.email}:${token}`)
      },
      createResetEmailLimiter({ now: () => time }),
      (line) => logs.push(line),
    )
    for (let i = 0; i < RESET_EMAIL_LIMIT + 2; i += 1) await send({ user: { email: EMAIL }, token: `tok${i}` })
    assert.equal(sent.length, RESET_EMAIL_LIMIT)
    assert.deepEqual(logs, [RESET_EMAIL_LIMITED_LOG, RESET_EMAIL_LIMITED_LOG])
    for (const line of logs) {
      assert.ok(!line.includes('alex') && !line.includes('example.com') && !line.includes('tok'))
    }

    // Case and spacing don't make a new account.
    await send({ user: { email: ' ALEX@Example.com ' }, token: 'tokX' })
    assert.equal(sent.length, RESET_EMAIL_LIMIT)
    // Another account is unaffected.
    await send({ user: { email: 'sam@example.com' }, token: 'tokS' })
    assert.equal(sent.length, RESET_EMAIL_LIMIT + 1)
    // After the window the account can be sent to again.
    time = RESET_EMAIL_WINDOW_MS
    await send({ user: { email: EMAIL }, token: 'tokLater' })
    assert.equal(sent.length, RESET_EMAIL_LIMIT + 2)
  })

  it('keys on a hash, never the email itself', () => {
    const key = resetEmailKey(EMAIL)
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.ok(!key.includes('alex'))
    assert.equal(resetEmailKey(' Alex@Example.COM '), key)
  })
})

describe('reset email limit through Better Auth', () => {
  let outbox: { to: string; text: string }[] = []
  let logLines: string[] = []

  function makeAuth() {
    return betterAuth({
      database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
      baseURL: APP_URL,
      secret: 'test-only-secret-at-least-32-characters',
      trustedOrigins: [APP_URL],
      rateLimit: { enabled: false },
      logger: { level: 'debug', log: (level, message) => logLines.push(`${level} ${message}`) },
      emailAndPassword: emailAndPasswordOptions(APP_URL, async (message) => {
        outbox.push(message)
        return { delivered: true }
      }),
    })
  }

  beforeEach(() => {
    outbox = []
    logLines = []
  })

  async function requestReset(auth: ReturnType<typeof makeAuth>, email: string) {
    const response = await auth.handler(
      new Request(`${APP_URL}/api/auth/request-password-reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL },
        body: JSON.stringify({ email, redirectTo: '/reset-password' }),
      }),
    )
    return { status: response.status, body: await response.text() }
  }

  it('sends at most the limit per account and answers every request the same way', async () => {
    const auth = makeAuth()
    await auth.api.signUpEmail({ body: { email: EMAIL, password: 'correct-horse-battery', name: 'Alex' } })
    const warn = console.warn
    const consoleLines: string[] = []
    console.warn = (...args: unknown[]) => consoleLines.push(args.map(String).join(' '))
    const replies: { status: number; body: string }[] = []
    try {
      for (let i = 0; i < RESET_EMAIL_LIMIT + 2; i += 1) replies.push(await requestReset(auth, EMAIL))
      replies.push(await requestReset(auth, 'nobody@example.com'))
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      console.warn = warn
    }
    assert.equal(outbox.filter((m) => m.to === EMAIL).length, RESET_EMAIL_LIMIT)
    assert.equal(new Set(replies.map((r) => `${r.status} ${r.body}`)).size, 1, 'one neutral reply for every request')
    assert.deepEqual(consoleLines, [RESET_EMAIL_LIMITED_LOG, RESET_EMAIL_LIMITED_LOG])
    for (const line of [...consoleLines, ...logLines.filter((l) => l.includes('Reset email'))]) {
      assert.ok(!line.includes(EMAIL))
    }
  })
})
