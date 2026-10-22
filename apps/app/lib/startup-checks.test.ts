import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  exitOnStartupProblems,
  productionDatabasePasswordProblem,
  startupProblems,
} from './startup-checks'

/**
 * Server start checks (lib/startup-checks.ts, run from instrumentation.ts).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.join(__dirname, '..')
const GOOD_SECRET = 'k'.repeat(32)
const GOOD_DB = 'postgres://app:Unique-Value-123@db.example:5432/hitly'
const prod = (extra: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: GOOD_SECRET,
  DATABASE_URL: GOOD_DB,
  ...extra,
})

describe('database password check', () => {
  it('refuses development and placeholder passwords, in any letter case', () => {
    for (const password of ['hitly', 'HITLY', 'postgres', 'password', 'changeme', 'change-me', 'replace-me', 'placeholder']) {
      const problem = productionDatabasePasswordProblem(`postgres://hitly:${password}@db.example:5432/hitly`)
      assert.ok(problem, password)
      // A fixed message: it names the variable and never repeats the URL or password.
      assert.equal(problem, 'DATABASE_URL uses a development or placeholder password; set a unique password in production')
    }
    assert.ok(productionDatabasePasswordProblem('postgres://u:%68itly@db.example/hitly'), 'percent-encoded')
  })

  it('accepts a unique password, no password, or no database', () => {
    assert.equal(productionDatabasePasswordProblem(GOOD_DB), null)
    assert.equal(productionDatabasePasswordProblem('postgres://app@db.example/hitly'), null)
    assert.equal(productionDatabasePasswordProblem(undefined), null)
    assert.equal(productionDatabasePasswordProblem(''), null)
  })

  it('refuses a value that is not a URL without repeating it', () => {
    const problem = productionDatabasePasswordProblem('not a url with hitly inside')
    assert.match(problem ?? '', /DATABASE_URL is not a valid connection URL/)
  })
})

describe('startup problems', () => {
  it('passes a good production configuration', () => {
    assert.deepEqual(startupProblems(prod()), [])
  })

  it('reports a bad secret and a development database password in production', () => {
    const problems = startupProblems(prod({ BETTER_AUTH_SECRET: 'short', DATABASE_URL: 'postgres://hitly:hitly@db.example/hitly' }))
    assert.equal(problems.length, 2)
    assert.match(problems[0]!, /BETTER_AUTH_SECRET/)
    assert.match(problems[1]!, /DATABASE_URL/)
    assert.ok(problems.every((p) => !p.includes('short') && !p.includes(':hitly@')))
  })

  it('only applies the production checks when NODE_ENV is exactly production', () => {
    const dev = { BETTER_AUTH_SECRET: '', DATABASE_URL: 'postgres://hitly:hitly@localhost:5432/hitly' }
    for (const NODE_ENV of [undefined, 'development', 'test', 'Production', 'PRODUCTION', 'prod', ' production']) {
      assert.deepEqual(startupProblems({ ...dev, NODE_ENV }), [], String(NODE_ENV))
    }
  })

  it('refuses a malformed HITLY_TRUSTED_PROXIES in every environment', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const problems = startupProblems({ ...prod({ NODE_ENV }), HITLY_TRUSTED_PROXIES: 'proxy.example' })
      assert.equal(problems.length, 1)
      assert.match(problems[0]!, /HITLY_TRUSTED_PROXIES/)
      assert.ok(!problems[0]!.includes('proxy.example'))
    }
  })

  it('logs each problem and exits with status 1', () => {
    const lines: string[] = []
    let code: number | undefined
    assert.throws(
      () =>
        exitOnStartupProblems({
          env: prod({ DATABASE_URL: 'postgres://hitly:hitly@db.example/hitly' }),
          log: (line) => lines.push(line),
          exit: (c) => {
            code = c
            throw new Error('exit')
          },
        }),
      /exit/,
    )
    assert.equal(code, 1)
    assert.deepEqual(lines, [
      '[hitly startup] DATABASE_URL uses a development or placeholder password; set a unique password in production; refusing to start.',
    ])
    let called = false
    exitOnStartupProblems({ env: prod(), log: () => {}, exit: () => ((called = true), undefined as never) })
    assert.equal(called, false)
  })
})

describe('server start (instrumentation register)', () => {
  function startServer(env: Record<string, string | undefined>) {
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, NEXT_RUNTIME: 'nodejs', ...env })) {
      if (value !== undefined) childEnv[key] = value
    }
    return spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "const m = await import('./instrumentation.ts'); await (m.register ?? m.default.register)(); console.log('register returned')",
      ],
      { cwd: appDir, env: childEnv as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 60_000 },
    )
  }

  it('exits with status 1 on a development database password in production', () => {
    const result = startServer(prod({ DATABASE_URL: 'postgres://hitly:hitly@db.example:5432/hitly' }))
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /DATABASE_URL uses a development or placeholder password/)
    assert.ok(!result.stdout.includes('register returned'))
    assert.ok(!`${result.stdout}${result.stderr}`.includes('hitly:hitly'), 'the URL is never printed')
  })

  it('exits with status 1 on an unusable BETTER_AUTH_SECRET in production', () => {
    const result = startServer(prod({ BETTER_AUTH_SECRET: 'too-short-secret' }))
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /BETTER_AUTH_SECRET must be at least 32 characters/)
    assert.ok(!`${result.stdout}${result.stderr}`.includes('too-short-secret'))
  })

  it('exits with status 1 on a malformed HITLY_TRUSTED_PROXIES', () => {
    const result = startServer({ NODE_ENV: 'development', HITLY_TRUSTED_PROXIES: '192.0.2.300' })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /HITLY_TRUSTED_PROXIES/)
    assert.ok(!`${result.stdout}${result.stderr}`.includes('192.0.2.300'))
  })

  it('runs the checks before anything else starts', () => {
    const source = fs.readFileSync(path.join(appDir, 'instrumentation.ts'), 'utf-8')
    const check = source.indexOf('exitOnStartupProblems()')
    assert.ok(check > 0, 'register must call exitOnStartupProblems')
    assert.ok(check < source.indexOf('destinationPolicyStartupNotice()'))
    assert.ok(check < source.indexOf('startHousekeeping()'))
  })
})
