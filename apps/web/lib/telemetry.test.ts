import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applyNextTelemetryDisabled,
  HITLY_TELEMETRY_ENV,
  isHitlyTelemetryEnabled,
  PLAUSIBLE_DOMAIN_ENV,
  PLAUSIBLE_SRC_ENV,
  plausibleScript,
} from './telemetry'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../..')
const wrapper = join(repoRoot, 'scripts/with-hitly-telemetry.sh')

const HITLY_NET_EXAMPLE = {
  [HITLY_TELEMETRY_ENV]: '1',
  [PLAUSIBLE_DOMAIN_ENV]: 'hitly.net',
  [PLAUSIBLE_SRC_ENV]: 'https://click.hitly.net/js/script.js',
}

test('HITLY_TELEMETRY is off unless it is exactly 1 or true', () => {
  assert.equal(isHitlyTelemetryEnabled({}), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '   ' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '0' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'false' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'yes' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'TRUE' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '1' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'true' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: ' 1 ' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: ' true ' }), true)
})

test('applyNextTelemetryDisabled: unset flag → NEXT_TELEMETRY_DISABLED=1', () => {
  const env: Record<string, string | undefined> = {}
  applyNextTelemetryDisabled(env)
  assert.equal(env.NEXT_TELEMETRY_DISABLED, '1')
  const already = { NEXT_TELEMETRY_DISABLED: '0' }
  applyNextTelemetryDisabled(already)
  assert.equal(already.NEXT_TELEMETRY_DISABLED, '1')
})

test('applyNextTelemetryDisabled: enabled flag clears NEXT_TELEMETRY_DISABLED', () => {
  const env = { [HITLY_TELEMETRY_ENV]: '1', NEXT_TELEMETRY_DISABLED: '1' }
  applyNextTelemetryDisabled(env)
  assert.equal(env.NEXT_TELEMETRY_DISABLED, undefined)
  const viaTrue = { [HITLY_TELEMETRY_ENV]: 'true', NEXT_TELEMETRY_DISABLED: '1' }
  applyNextTelemetryDisabled(viaTrue)
  assert.equal(viaTrue.NEXT_TELEMETRY_DISABLED, undefined)
})

test('plausibleScript: absent when HITLY_TELEMETRY is unset', () => {
  assert.equal(plausibleScript({}), null)
  assert.equal(
    plausibleScript({
      [PLAUSIBLE_DOMAIN_ENV]: 'hitly.net',
      [PLAUSIBLE_SRC_ENV]: 'https://click.hitly.net/js/script.js',
    }),
    null,
  )
})

test('plausibleScript: absent when enabled but domain or src is missing (no hardcoded defaults)', () => {
  assert.equal(plausibleScript({ [HITLY_TELEMETRY_ENV]: '1' }), null)
  assert.equal(plausibleScript({ [HITLY_TELEMETRY_ENV]: 'true', [PLAUSIBLE_DOMAIN_ENV]: 'hitly.net' }), null)
  assert.equal(
    plausibleScript({
      [HITLY_TELEMETRY_ENV]: '1',
      [PLAUSIBLE_SRC_ENV]: 'https://click.hitly.net/js/script.js',
    }),
    null,
  )
  assert.equal(
    plausibleScript({
      [HITLY_TELEMETRY_ENV]: '1',
      [PLAUSIBLE_DOMAIN_ENV]: '  ',
      [PLAUSIBLE_SRC_ENV]: 'https://click.hitly.net/js/script.js',
    }),
    null,
  )
})

test('plausibleScript: present with env attributes when HITLY_TELEMETRY is enabled', () => {
  assert.deepEqual(plausibleScript(HITLY_NET_EXAMPLE), {
    src: 'https://click.hitly.net/js/script.js',
    domain: 'hitly.net',
  })
  assert.deepEqual(
    plausibleScript({
      [HITLY_TELEMETRY_ENV]: 'true',
      [PLAUSIBLE_DOMAIN_ENV]: '  docs.example.com  ',
      [PLAUSIBLE_SRC_ENV]: '  https://plausible.example.com/js/script.js  ',
    }),
    { src: 'https://plausible.example.com/js/script.js', domain: 'docs.example.com' },
  )
})

test('web layout renders the snippet only through plausibleScript (no hardcoded tag)', () => {
  const layout = readFileSync(join(here, '../app/layout.tsx'), 'utf8')
  assert.match(layout, /plausibleScript/)
  assert.match(layout, /HITLY_TELEMETRY/)
  assert.doesNotMatch(layout, /click\.hitly\.net/)
  assert.doesNotMatch(layout, /data-domain=\{['"]hitly\.net['"]\}/)
  assert.doesNotMatch(layout, /src=["']https:\/\//)
})

test('inbox app layout never loads Plausible', () => {
  const layout = readFileSync(join(here, '../../app/app/layout.tsx'), 'utf8')
  assert.doesNotMatch(layout, /plausible/i)
  assert.doesNotMatch(layout, /click\.hitly\.net/)
  assert.doesNotMatch(layout, /next\/script/)
})

test('Next configs derive NEXT_TELEMETRY_DISABLED from HITLY_TELEMETRY', () => {
  for (const rel of ['../next.config.mjs', '../../app/next.config.mjs']) {
    const src = readFileSync(join(here, rel), 'utf8')
    assert.match(src, /HITLY_TELEMETRY/, rel)
    assert.match(src, /NEXT_TELEMETRY_DISABLED/, rel)
    assert.match(src, /=== '1'/, rel)
    assert.match(src, /=== 'true'/, rel)
  }
})

function printDisabled(env: Record<string, string | undefined>): string {
  const merged: Record<string, string | undefined> = { ...process.env, ...env }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return execFileSync('bash', [wrapper, 'bash', '-c', 'printf %s "${NEXT_TELEMETRY_DISABLED-}"'], {
    env: merged as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
}

test('with-hitly-telemetry.sh defaults NEXT_TELEMETRY_DISABLED=1', () => {
  assert.equal(printDisabled({ HITLY_TELEMETRY: undefined, NEXT_TELEMETRY_DISABLED: undefined }), '1')
  assert.equal(printDisabled({ HITLY_TELEMETRY: '', NEXT_TELEMETRY_DISABLED: undefined }), '1')
  assert.equal(printDisabled({ HITLY_TELEMETRY: '0', NEXT_TELEMETRY_DISABLED: undefined }), '1')
})

test('with-hitly-telemetry.sh leaves Next telemetry on when HITLY_TELEMETRY is 1 or true', () => {
  assert.equal(printDisabled({ HITLY_TELEMETRY: '1', NEXT_TELEMETRY_DISABLED: '1' }), '')
  assert.equal(printDisabled({ HITLY_TELEMETRY: 'true', NEXT_TELEMETRY_DISABLED: '1' }), '')
})
