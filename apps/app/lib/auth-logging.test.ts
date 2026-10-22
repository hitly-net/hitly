import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { emailAndPasswordOptions } from './auth-email-password'
import {
  AUTH_REQUEST_FAILED_LOG,
  authLogger,
  createAuthApiErrorHandler,
  createAuthLogger,
  handleAuthApiError,
  redactSecrets,
} from './auth-logging'

/**
 * Better Auth logging never writes reset tokens (lib/auth-logging.ts, wired in
 * lib/auth.ts).
 */

const APP_URL = 'http://localhost:3001'
const TOKEN = 'Zq3xV9pLm2Rt8Kw1Yb7Nc4Hd'

/** A database error shaped like the driver's: the query, then its parameters. */
function queryError() {
  const error = new Error(
    `Failed query: select "id" from "verifications" where "identifier" = $1 limit $2\nparams: reset-password:${TOKEN},1`,
  )
  ;(error as Error & { cause?: unknown }).cause = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
  return error
}

describe('redaction', () => {
  it('removes query parameters, verification identifiers and URL tokens', () => {
    assert.equal(redactSecrets('Failed query: select 1\nparams: reset-password:abc,1'), 'Failed query: select 1\nparams: [redacted]')
    assert.equal(redactSecrets(`lookup reset-password:${TOKEN} failed`), 'lookup reset-password:[redacted] failed')
    assert.equal(redactSecrets(`${APP_URL}/reset-password?token=${TOKEN}&x=1`), `${APP_URL}/reset-password?token=[redacted]&x=1`)
    assert.equal(redactSecrets('Rate limit reached'), 'Rate limit reached')
  })

  it('the Better Auth logger writes errors without the token or stack', () => {
    const lines: string[] = []
    const logger = createAuthLogger((level, line) => lines.push(`${level} ${line}`))
    logger.log('error', 'Error', queryError())
    logger.log('error', `Failed for reset-password:${TOKEN}`, { identifier: `reset-password:${TOKEN}` })
    assert.equal(lines.length, 2)
    for (const line of lines) assert.ok(!line.includes(TOKEN), line)
    assert.match(lines[0]!, /params: \[redacted\] cause=ECONNREFUSED/)
    assert.ok(!lines[0]!.includes('    at '), 'no stack trace')
  })

  it('the error hook passes API errors through and turns other errors into a plain 500', () => {
    const lines: string[] = []
    const handle = createAuthApiErrorHandler((line) => lines.push(line))
    const badRequest = new APIError('BAD_REQUEST', { message: 'Invalid token' })
    assert.throws(() => handle(badRequest), (e) => e === badRequest)
    assert.equal(lines.length, 0)
    assert.throws(
      () => handle(queryError()),
      (e: unknown) => e instanceof APIError && e.status === 'INTERNAL_SERVER_ERROR' && !String(e.message).includes(TOKEN),
    )
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.startsWith(AUTH_REQUEST_FAILED_LOG))
    assert.ok(!lines[0]!.includes(TOKEN))
  })
})

describe('reset submit while the database fails', () => {
  it('answers 500 and no log line or console output contains the token', async () => {
    const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
    const base = memoryAdapter(db)
    let failVerification = false
    const failing: typeof base = (options) => {
      const adapter = base(options)
      const guard =
        <F extends (args: { model: string }) => Promise<unknown>>(fn: F) =>
        (async (args: { model: string }) => {
          if (failVerification && args.model === 'verification') throw queryError()
          return fn(args)
        }) as unknown as F
      const wrapped: typeof adapter = {
        ...adapter,
        findOne: guard(adapter.findOne as never),
        findMany: guard(adapter.findMany as never),
        // Run transactions on the wrapped adapter so the failure applies inside them too.
        transaction: async (callback) => callback(wrapped as never),
      }
      return wrapped
    }
    const captured: string[] = []
    const auth = betterAuth({
      database: failing,
      baseURL: APP_URL,
      secret: 'test-only-secret-at-least-32-characters',
      trustedOrigins: [APP_URL],
      rateLimit: { enabled: false },
      logger: createAuthLogger((level, line) => captured.push(line)),
      onAPIError: { onError: createAuthApiErrorHandler((line) => captured.push(line)) },
      emailAndPassword: emailAndPasswordOptions(APP_URL, async () => ({})),
    })
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const saved = methods.map((m) => console[m])
    for (const m of methods) console[m] = (...args: unknown[]) => captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '))
    let status = 0
    try {
      failVerification = true
      const response = await auth.handler(
        new Request(`${APP_URL}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: APP_URL },
          body: JSON.stringify({ newPassword: 'another-password-123', token: TOKEN }),
        }),
      )
      status = response.status
      assert.ok(!(await response.text()).includes(TOKEN))
    } finally {
      methods.forEach((m, i) => (console[m] = saved[i]!))
    }
    assert.equal(status, 500)
    assert.ok(captured.some((line) => line.startsWith(AUTH_REQUEST_FAILED_LOG)), 'one value-free failure line')
    assert.ok(!captured.some((line) => line.includes('SERVER_ERROR')), 'the router does not print the raw error')
    for (const line of captured) assert.ok(!line.includes(TOKEN), line)
  })

  it('lib/auth.ts uses the redacting logger and error hook', async () => {
    const env = process.env as Record<string, string | undefined>
    const saved = env.DATABASE_URL
    // A pool is created lazily and never connects in this test.
    env.DATABASE_URL = 'postgres://user:pass@db.example:1/unused'
    try {
      const { auth } = await import('./auth')
      assert.ok(auth)
      const context = await auth.$context
      assert.equal(context.options.logger, authLogger)
      assert.equal(context.options.onAPIError?.onError, handleAuthApiError)
    } finally {
      if (saved === undefined) delete env.DATABASE_URL
      else env.DATABASE_URL = saved
    }
  })
})
