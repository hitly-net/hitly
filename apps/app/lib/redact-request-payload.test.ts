import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  REDACTED,
  isSecretRequestKey,
  redactRequestPayload,
  redactedRequestJson,
  redactedRequestJsonFromCanonical,
} from './redact-request-payload'

describe('isSecretRequestKey', () => {
  it('flags cb_auth_token, resume handles, and secret-like names', () => {
    for (const key of [
      'cb_auth_token',
      'cbAuthToken',
      'resumeHandle',
      'resume_handle',
      'resumeUrl',
      'apiKey',
      'api_key',
      'authorization',
      'token',
      'access_token',
      'client_secret',
      'reviewToken',
    ]) {
      assert.equal(isSecretRequestKey(key), true, key)
    }
  })

  it('leaves ordinary request fields alone', () => {
    for (const key of ['amount', 'currency', 'action', 'args', 'name', 'runId', 'stepId', 'toolCallId', 'contextMarkdown']) {
      assert.equal(isSecretRequestKey(key), false, key)
    }
  })
})

describe('redactRequestPayload', () => {
  it('redacts cb_auth_token, resumeHandle, and nested secret-like fields', () => {
    const input = {
      action: { name: 'pay', args: { amount: 100, cb_auth_token: 'tok_live_abc', apiKey: 'sk_live_abc' } },
      origin: {
        plugin: 'http',
        runId: 'run_1',
        resumeHandle: { resumeUrl: 'https://origin.example/resume?token=abc', reviewToken: 'rt_1' },
      },
    }
    const redacted = redactRequestPayload(input) as {
      action: { name: string; args: Record<string, unknown> }
      origin: { plugin: string; runId: string; resumeHandle: unknown }
    }
    assert.equal(redacted.action.name, 'pay')
    assert.equal(redacted.action.args.amount, 100)
    assert.equal(redacted.action.args.cb_auth_token, REDACTED)
    assert.equal(redacted.action.args.apiKey, REDACTED)
    assert.equal(redacted.origin.plugin, 'http')
    assert.equal(redacted.origin.runId, 'run_1')
    assert.equal(redacted.origin.resumeHandle, REDACTED)
    assert.equal(JSON.stringify(redacted).includes('tok_live_abc'), false)
    assert.equal(JSON.stringify(redacted).includes('sk_live_abc'), false)
    assert.equal(JSON.stringify(redacted).includes('origin.example'), false)
    assert.equal(JSON.stringify(redacted).includes('rt_1'), false)
  })

  it('is idempotent', () => {
    const once = redactRequestPayload({ cb_auth_token: 'x', amount: 1 })
    assert.deepEqual(redactRequestPayload(once), once)
  })
})

describe('redactedRequestJson', () => {
  it('pretty-prints the redacted object for copy/download', () => {
    const json = redactedRequestJson({ amount: 2, cb_auth_token: 'hidden' })
    assert.equal(json.includes('hidden'), false)
    assert.equal(json.includes(REDACTED), true)
    assert.equal(json.includes('\n'), true)
    assert.equal(json, redactedRequestJsonFromCanonical('{"amount":2,"cb_auth_token":"hidden"}'))
  })
})
