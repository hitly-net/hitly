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

  it('flags secretKey (dropping includes("secret") must go red)', () => {
    assert.equal(isSecretRequestKey('secretKey'), true)
    assert.equal(isSecretRequestKey('secret_key'), true)
    assert.equal(isSecretRequestKey('SecretKey'), true)
  })

  it('flags AWS_SECRET_ACCESS_KEY and *_SECRET_* env-style keys (dropping includes("secret") must go red)', () => {
    assert.equal(isSecretRequestKey('AWS_SECRET_ACCESS_KEY'), true)
    assert.equal(isSecretRequestKey('aws_secret_access_key'), true)
    assert.equal(isSecretRequestKey('FOO_SECRET_BAR'), true)
    assert.equal(isSecretRequestKey('MY_SECRET_NAME'), true)
  })

  it('flags tokenValue (dropping includes("token") back to endsWith("token") must go red)', () => {
    assert.equal(isSecretRequestKey('tokenValue'), true)
    assert.equal(isSecretRequestKey('token_value'), true)
    assert.equal(isSecretRequestKey('TokenValue'), true)
    assert.equal(isSecretRequestKey('fooTokenValue'), true)
  })

  it('flags cookie / set-cookie (dropping includes("cookie") must go red)', () => {
    assert.equal(isSecretRequestKey('cookie'), true)
    assert.equal(isSecretRequestKey('Cookie'), true)
    assert.equal(isSecretRequestKey('set-cookie'), true)
    assert.equal(isSecretRequestKey('Set-Cookie'), true)
    assert.equal(isSecretRequestKey('cookieHeader'), true)
  })

  it('flags signature (dropping includes("signature") must go red)', () => {
    assert.equal(isSecretRequestKey('signature'), true)
    assert.equal(isSecretRequestKey('Signature'), true)
    assert.equal(isSecretRequestKey('x-hitly-signature'), true)
  })

  it('folds NFKC fullwidth, zero-width, and common Cyrillic/Greek homoglyphs', () => {
    assert.equal(isSecretRequestKey('ｓｅｃｒｅｔ'), true, 'fullwidth NFKC')
    assert.equal(isSecretRequestKey('sec\u200Bret'), true, 'zero-width joiner stripped')
    assert.equal(isSecretRequestKey('se\u0441ret'), true, 'Cyrillic s/c lookalike')
    assert.equal(isSecretRequestKey('t\u043Eken'), true, 'Cyrillic o lookalike')
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

  it('redacts the widened matcher keys, nested keys, _meta, and origin.resumeHandle', () => {
    const input = {
      action: {
        name: 'pay',
        args: {
          amount: 9,
          secretKey: 'canary-secretKey',
          AWS_SECRET_ACCESS_KEY: 'canary-aws',
          FOO_SECRET_BAR: 'canary-env-secret',
          tokenValue: 'canary-tokenValue',
          cookie: 'canary-cookie',
          'set-cookie': 'canary-set-cookie',
          signature: 'canary-signature',
          nested: { callback_secret: 'canary-nested' },
        },
      },
      _meta: { cb_auth_token: 'canary-meta' },
      origin: {
        plugin: 'http',
        runId: 'run_2',
        resumeHandle: { resumeUrl: 'https://origin.example/resume', reviewToken: 'canary-review' },
      },
    }
    const json = JSON.stringify(redactRequestPayload(input))
    for (const canary of [
      'canary-secretKey',
      'canary-aws',
      'canary-env-secret',
      'canary-tokenValue',
      'canary-cookie',
      'canary-set-cookie',
      'canary-signature',
      'canary-nested',
      'canary-meta',
      'canary-review',
      'origin.example',
    ]) {
      assert.equal(json.includes(canary), false, canary)
    }
    const redacted = redactRequestPayload(input) as {
      action: { args: { amount: number } }
      origin: { runId: string; resumeHandle: unknown }
    }
    assert.equal(redacted.action.args.amount, 9)
    assert.equal(redacted.origin.runId, 'run_2')
    assert.equal(redacted.origin.resumeHandle, REDACTED)
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
