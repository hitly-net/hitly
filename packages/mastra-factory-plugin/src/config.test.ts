import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRuntimeConfig, parseDeploymentConfig, DEFAULT_POLL_INTERVAL_MS } from './config.ts'

const baseEnv = {
  HITLY_API_URL: 'https://hitly.example.com',
  HITLY_API_KEY: 'hk_test_1',
  HITLY_PROJECT_ID: 'proj-1',
  HITLY_PUBLIC_URL: 'https://factory.example.com',
  HITLY_WEBHOOK_SIGNING_SECRETS: 'whsec_a,whsec_b',
}

test('parses the documented env contract', () => {
  const config = parseRuntimeConfig(baseEnv)
  assert.equal(config.hitlyBaseUrl, 'https://hitly.example.com')
  assert.equal(config.hitlyApiKey, 'hk_test_1')
  assert.equal(config.projectId, 'proj-1')
  assert.equal(config.publicBaseUrl, 'https://factory.example.com')
  assert.deepEqual(config.webhookSigningSecrets, ['whsec_a', 'whsec_b'])
})

test('webhook signing secrets list tolerates whitespace and empty entries', () => {
  const config = parseRuntimeConfig({ ...baseEnv, HITLY_WEBHOOK_SIGNING_SECRETS: ' whsec_a , ,whsec_b,' })
  assert.deepEqual(config.webhookSigningSecrets, ['whsec_a', 'whsec_b'])
})

test('single-secret env var is accepted', () => {
  const { HITLY_WEBHOOK_SIGNING_SECRETS: _drop, ...rest } = baseEnv
  const config = parseRuntimeConfig({ ...rest, HITLY_WEBHOOK_SIGNING_SECRET: 'whsec_only' })
  assert.deepEqual(config.webhookSigningSecrets, ['whsec_only'])
})

test('missing required bootstrap values throw with the var names', () => {
  const { HITLY_API_KEY: _drop, ...rest } = baseEnv
  assert.throws(() => parseRuntimeConfig(rest), /HITLY_API_KEY/)
})

test('missing webhook signing secrets throws with the var name', () => {
  const { HITLY_WEBHOOK_SIGNING_SECRETS: _drop, ...rest } = baseEnv
  assert.throws(() => parseRuntimeConfig(rest), /HITLY_WEBHOOK_SIGNING_SECRETS/)
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

test('deployment config without env fallback needs only HITLY_PUBLIC_URL', () => {
  const deployment = parseDeploymentConfig({ HITLY_PUBLIC_URL: 'https://factory.example.com/' })
  assert.deepEqual(deployment.envFallback, { mode: 'none' })
  assert.equal(deployment.config.publicBaseUrl, 'https://factory.example.com')
  assert.equal(deployment.config.hitlyApiKey, '')
  assert.equal(deployment.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)
})

test('deployment config still requires HITLY_PUBLIC_URL with no fallback', () => {
  assert.throws(() => parseDeploymentConfig({}), /HITLY_PUBLIC_URL/)
})

test('deployment config keeps the optional github token without fallback', () => {
  const deployment = parseDeploymentConfig({ HITLY_PUBLIC_URL: 'https://f.example.com', HITLY_GITHUB_TOKEN: 'ghp_x' })
  assert.equal(deployment.config.githubToken, 'ghp_x')
})

test('env fallback=all requires the full credential contract', () => {
  assert.throws(
    () => parseDeploymentConfig({ HITLY_PUBLIC_URL: 'https://f.example.com', HITLY_ENV_FALLBACK: 'all' }),
    /HITLY_API_URL/,
  )
  const deployment = parseDeploymentConfig({ ...baseEnv, HITLY_ENV_FALLBACK: 'ALL' })
  assert.deepEqual(deployment.envFallback, { mode: 'all' })
  assert.equal(deployment.config.hitlyApiKey, 'hk_test_1')
})

test('env fallback list parses factory project ids', () => {
  const deployment = parseDeploymentConfig({ ...baseEnv, HITLY_ENV_FALLBACK: ' fproj_1 , fproj_2 ,' })
  assert.equal(deployment.envFallback.mode, 'list')
  assert.deepEqual([...(deployment.envFallback as { factoryProjectIds: Set<string> }).factoryProjectIds], ['fproj_1', 'fproj_2'])
})
