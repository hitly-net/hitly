import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRuntimeConfig, DEFAULT_POLL_INTERVAL_MS } from './config.ts'

const baseEnv = {
  HITLY_API_URL: 'https://hitly.example.com',
  HITLY_API_KEY: 'hk_test_1',
  HITLY_PROJECT_ID: 'proj-1',
  HITLY_PUBLIC_URL: 'https://factory.example.com',
  HITLY_CALLBACK_BEARER: 'cb_secret',
  HITLY_RESUME_SECRETS: 'whsec_a,whsec_b',
}

test('parses the documented env contract', () => {
  const config = parseRuntimeConfig(baseEnv)
  assert.equal(config.hitlyBaseUrl, 'https://hitly.example.com')
  assert.equal(config.hitlyApiKey, 'hk_test_1')
  assert.equal(config.projectId, 'proj-1')
  assert.equal(config.publicBaseUrl, 'https://factory.example.com')
  assert.equal(config.callbackBearer, 'cb_secret')
  assert.deepEqual(config.resumeSecrets, ['whsec_a', 'whsec_b'])
})

test('resume secrets list tolerates whitespace and empty entries', () => {
  const config = parseRuntimeConfig({ ...baseEnv, HITLY_RESUME_SECRETS: ' whsec_a , ,whsec_b,' })
  assert.deepEqual(config.resumeSecrets, ['whsec_a', 'whsec_b'])
})

test('single-secret legacy env var is accepted', () => {
  const { HITLY_RESUME_SECRETS: _drop, ...rest } = baseEnv
  const config = parseRuntimeConfig({ ...rest, HITLY_RESUME_SECRET: 'whsec_only' })
  assert.deepEqual(config.resumeSecrets, ['whsec_only'])
})

test('missing required bootstrap values throw with the var names', () => {
  const { HITLY_API_KEY: _drop, ...rest } = baseEnv
  assert.throws(() => parseRuntimeConfig(rest), /HITLY_API_KEY/)
})

test('gates default to ON; explicit false turns a gate off', () => {
  const defaults = parseRuntimeConfig(baseEnv)
  assert.deepEqual(defaults.gates, { plan: true, review: true, ask_user: true })
  const off = parseRuntimeConfig({ ...baseEnv, HITLY_GATE_ASK_USER: 'false' })
  assert.equal(off.gates.ask_user, false)
  assert.equal(off.gates.plan, true)
})

test('merge-after-accept defaults to OFF — merging is opt-in', () => {
  assert.equal(parseRuntimeConfig(baseEnv).mergeAfterAccept, false)
  assert.equal(parseRuntimeConfig({ ...baseEnv, HITLY_MERGE_AFTER_ACCEPT: 'true' }).mergeAfterAccept, true)
})

test('poll interval defaults and parses', () => {
  assert.equal(parseRuntimeConfig(baseEnv).pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
  assert.equal(parseRuntimeConfig({ ...baseEnv, HITLY_POLL_INTERVAL_MS: '5000' }).pollIntervalMs, 5000)
})

test('github token is optional; absent it disables merge attempts', () => {
  assert.equal(parseRuntimeConfig(baseEnv).githubToken, undefined)
  assert.equal(parseRuntimeConfig({ ...baseEnv, HITLY_GITHUB_TOKEN: 'ghp_x' }).githubToken, 'ghp_x')
})

test('trailing slashes in URLs are normalized (no double-slash API paths)', () => {
  const config = parseRuntimeConfig({ ...baseEnv, HITLY_API_URL: 'https://hitly.example.com/' })
  assert.equal(config.hitlyBaseUrl, 'https://hitly.example.com')
})
