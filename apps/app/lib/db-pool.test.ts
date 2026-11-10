import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DB_CONNECTION_TIMEOUT_MS_ENV,
  DB_POOL_MAX_ENV,
  DEFAULT_DB_CONNECTION_TIMEOUT_MS,
  DEFAULT_DB_POOL_MAX,
  MIN_DB_POOL_MAX,
  createAppPool,
  dbConnectionTimeoutMsProblem,
  dbPoolMaxProblem,
  postgresPoolOptions,
} from './db-pool'

const EXAMPLE_URL = 'postgres://app:unique-password@db.example:5432/hitly'

describe('Postgres pool options', () => {
  it('defaults connectionTimeoutMillis to 5000 and max to 10', async () => {
    assert.deepEqual(postgresPoolOptions({}), {
      max: DEFAULT_DB_POOL_MAX,
      connectionTimeoutMillis: DEFAULT_DB_CONNECTION_TIMEOUT_MS,
    })
    const pool = createAppPool(EXAMPLE_URL)
    try {
      assert.equal(pool.options.connectionTimeoutMillis, DEFAULT_DB_CONNECTION_TIMEOUT_MS)
      assert.equal(pool.options.max, DEFAULT_DB_POOL_MAX)
    } finally {
      await pool.end()
    }
  })

  it('lets HITLY_DB_CONNECTION_TIMEOUT_MS and HITLY_DB_POOL_MAX override the defaults', async () => {
    const env = {
      [DB_CONNECTION_TIMEOUT_MS_ENV]: '1500',
      [DB_POOL_MAX_ENV]: '8',
    }
    assert.deepEqual(postgresPoolOptions(env), { max: 8, connectionTimeoutMillis: 1500 })
    const pool = createAppPool(EXAMPLE_URL, env)
    try {
      assert.equal(pool.options.connectionTimeoutMillis, 1500)
      assert.equal(pool.options.max, 8)
    } finally {
      await pool.end()
    }
  })

  it('refuses a non-positive HITLY_DB_CONNECTION_TIMEOUT_MS without repeating the value', () => {
    for (const bad of ['0', '-1', 'abc', '5.5', '1e3', ' 5000ms']) {
      const problem = dbConnectionTimeoutMsProblem(bad)
      assert.ok(problem, bad)
      assert.match(problem, /HITLY_DB_CONNECTION_TIMEOUT_MS/)
      assert.match(problem, /positive integer/)
      assert.ok(!problem.includes(bad.trim()), bad)
    }
    assert.equal(dbConnectionTimeoutMsProblem(undefined), null)
    assert.equal(dbConnectionTimeoutMsProblem(''), null)
    assert.equal(dbConnectionTimeoutMsProblem('5000'), null)
  })

  it('refuses HITLY_DB_POOL_MAX below 3 without repeating the value or a URL', () => {
    for (const bad of ['1', '2', '0', 'abc', '3.5']) {
      const problem = dbPoolMaxProblem(bad)
      assert.ok(problem, bad)
      assert.match(problem, /HITLY_DB_POOL_MAX/)
      assert.match(problem, new RegExp(String(MIN_DB_POOL_MAX)))
      assert.ok(!problem.includes(bad), bad)
      assert.ok(!problem.includes(EXAMPLE_URL))
    }
    assert.equal(dbPoolMaxProblem(undefined), null)
    assert.equal(dbPoolMaxProblem(''), null)
    assert.equal(dbPoolMaxProblem('3'), null)
    assert.equal(dbPoolMaxProblem('10'), null)
  })
})
