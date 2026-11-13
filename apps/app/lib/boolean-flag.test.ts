/**
 * Shared boolean flag parser (S4): one parser for HITLY_REQUIRE_VERIFIED_EMAIL
 * and HITLY_SIGNUP_ENABLED, with a value-free startup warning for any
 * unrecognised value.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BOOLEAN_FLAG_FALSE_VALUES,
  BOOLEAN_FLAG_TRUE_VALUES,
  booleanFlagNotices,
  isBooleanFlag,
  parseBooleanFlagValue,
} from './boolean-flag'
import { isSignupEnabled } from './signup'
import { requireVerifiedEmailGateEnabled } from './verified-gate'
import { logStartupNotices } from './startup-checks'

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

describe('shared boolean flag parser', () => {
  it('accepts the documented ON values after trim + lowercase', () => {
    for (const raw of ['1', 'true', 'yes', 'on', ' TRUE ', 'On', 'YES']) {
      assert.equal(parseBooleanFlagValue(raw, false), true, `${raw} => ON`)
    }
    for (const raw of ['0', 'false', 'off', ' OFF ']) {
      assert.equal(parseBooleanFlagValue(raw, true), false, `${raw} => OFF`)
    }
  })

  it('unset or empty falls back to the flag default', () => {
    assert.equal(parseBooleanFlagValue(undefined, true), true)
    assert.equal(parseBooleanFlagValue('', false), false)
    assert.equal(parseBooleanFlagValue('   ', false), false)
  })

  it('unrecognised values fall back to the default', () => {
    for (const raw of ['maybe', '2', 'no', 'ture']) {
      assert.equal(parseBooleanFlagValue(raw, false), false, `${raw} => default OFF`)
      assert.equal(parseBooleanFlagValue(raw, true), true, `${raw} => default ON`)
    }
  })

  it('exposes the accepted value sets (docs parity)', () => {
    assert.deepEqual([...BOOLEAN_FLAG_TRUE_VALUES], ['1', 'true', 'yes', 'on'])
    assert.deepEqual([...BOOLEAN_FLAG_FALSE_VALUES], ['0', 'false', 'off'])
  })
})

describe('the gate flag uses the shared parser', () => {
  it('ON for any accepted truthy value, OFF otherwise', () => {
    for (const raw of ['1', 'true', 'yes', 'on', 'On ']) {
      withEnv('HITLY_REQUIRE_VERIFIED_EMAIL', raw, () => {
        assert.equal(requireVerifiedEmailGateEnabled(), true, `${raw} => ON`)
      })
    }
    for (const raw of ['0', 'false', 'off', 'maybe', '']) {
      withEnv('HITLY_REQUIRE_VERIFIED_EMAIL', raw, () => {
        assert.equal(requireVerifiedEmailGateEnabled(), false, `${raw} => OFF`)
      })
    }
    withEnv('HITLY_REQUIRE_VERIFIED_EMAIL', undefined, () => {
      assert.equal(requireVerifiedEmailGateEnabled(), false, 'unset => OFF (closed beta)')
    })
  })

  it('isBooleanFlag reads the provided env object', () => {
    assert.equal(isBooleanFlag('X_FLAG', false, { X_FLAG: 'yes' }), true)
    assert.equal(isBooleanFlag('X_FLAG', true, {}), true)
  })
})

describe('the signup flag keeps its pre-parser behaviour (default ON)', () => {
  it('matrix matches the old reader', () => {
    for (const [raw, expected] of [
      [undefined, true],
      ['1', true],
      ['true', true],
      ['0', false],
      ['false', false],
      ['off', false],
      ['garbage', true],
    ] as const) {
      withEnv('HITLY_SIGNUP_ENABLED', raw, () => {
        assert.equal(isSignupEnabled(), expected, `HITLY_SIGNUP_ENABLED=${String(raw)} => ${expected}`)
      })
    }
  })
})

describe('value-free startup warning on unrecognised values', () => {
  it('names the variable, never the value', () => {
    const lines = booleanFlagNotices({ HITLY_REQUIRE_VERIFIED_EMAIL: 's3cr3t-value' })
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /HITLY_REQUIRE_VERIFIED_EMAIL/)
    assert.ok(!lines[0]!.includes('s3cr3t-value'), 'the warning must not echo the value')
    assert.match(lines[0]!, /default \(off\)/)
  })

  it('silent for recognised values, unset flags; one line per offending flag', () => {
    assert.deepEqual(booleanFlagNotices({ HITLY_REQUIRE_VERIFIED_EMAIL: 'on', HITLY_SIGNUP_ENABLED: 'off' }), [])
    assert.deepEqual(booleanFlagNotices({}), [])
    const lines = booleanFlagNotices({ HITLY_REQUIRE_VERIFIED_EMAIL: 'maybe', HITLY_SIGNUP_ENABLED: 'nah' })
    assert.equal(lines.length, 2)
    assert.ok(lines.some((l) => l.includes('HITLY_REQUIRE_VERIFIED_EMAIL')))
    assert.ok(lines.some((l) => l.includes('HITLY_SIGNUP_ENABLED') && l.includes('default (on)')))
  })

  it('logStartupNotices emits the flag warnings through warn', () => {
    const warned: string[] = []
    logStartupNotices({
      env: { HITLY_REQUIRE_VERIFIED_EMAIL: 'sure?', HITLY_TRUSTED_PROXIES: '' },
      info: () => undefined,
      warn: (line) => warned.push(line),
    })
    assert.ok(
      warned.some((l) => l.includes('HITLY_REQUIRE_VERIFIED_EMAIL') && !l.includes('sure?')),
      'startup warns once, value-free',
    )
  })
})
