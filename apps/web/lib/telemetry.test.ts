import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  applyCliTelemetryDisabled,
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

test('HITLY_TELEMETRY is off unless trimmed value is 1 or true', () => {
  assert.equal(isHitlyTelemetryEnabled({}), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '   ' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '0' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'false' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'yes' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'TRUE' }), false)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '1' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: 'true' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: '1 ' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: ' true' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: ' 1 ' }), true)
  assert.equal(isHitlyTelemetryEnabled({ [HITLY_TELEMETRY_ENV]: ' true ' }), true)
})

test('applyCliTelemetryDisabled always sets Next and Turbo disable flags', () => {
  for (const flag of [undefined, '1', 'true', '0']) {
    const env: Record<string, string | undefined> = {
      [HITLY_TELEMETRY_ENV]: flag,
      NEXT_TELEMETRY_DISABLED: '0',
      TURBO_TELEMETRY_DISABLED: '0',
    }
    applyCliTelemetryDisabled(env)
    assert.equal(env.NEXT_TELEMETRY_DISABLED, '1', `HITLY_TELEMETRY=${String(flag)}`)
    assert.equal(env.TURBO_TELEMETRY_DISABLED, '1', `HITLY_TELEMETRY=${String(flag)}`)
  }
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

function printDisabled(env: Record<string, string | undefined>): string {
  const merged: Record<string, string | undefined> = { ...process.env, ...env }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return execFileSync(
    'bash',
    [wrapper, 'bash', '-c', 'printf %s "${NEXT_TELEMETRY_DISABLED-}|${TURBO_TELEMETRY_DISABLED-}"'],
    {
      env: merged as NodeJS.ProcessEnv,
      encoding: 'utf8',
    },
  )
}

test('Next configs always apply CLI telemetry disable and never read HITLY_TELEMETRY', () => {
  for (const rel of ['../next.config.mjs', '../../app/next.config.mjs']) {
    const src = readFileSync(join(here, rel), 'utf8')
    assert.match(src, /disable-cli-telemetry/, rel)
    assert.match(src, /applyCliTelemetryDisabled/, rel)
    assert.doesNotMatch(src, /HITLY_TELEMETRY/, rel)
  }
})

test('wrapper keeps Next and Turbo telemetry disabled whether HITLY_TELEMETRY is set or not', () => {
  assert.equal(printDisabled({ HITLY_TELEMETRY: undefined, NEXT_TELEMETRY_DISABLED: '0', TURBO_TELEMETRY_DISABLED: '0' }), '1|1')
  assert.equal(printDisabled({ HITLY_TELEMETRY: '1', NEXT_TELEMETRY_DISABLED: '0', TURBO_TELEMETRY_DISABLED: '0' }), '1|1')
  assert.equal(printDisabled({ HITLY_TELEMETRY: 'true', NEXT_TELEMETRY_DISABLED: undefined, TURBO_TELEMETRY_DISABLED: undefined }), '1|1')
})

test('next.config path keeps Next and Turbo telemetry disabled whether HITLY_TELEMETRY is set or not', async () => {
  const helperUrl = pathToFileURL(join(repoRoot, 'scripts/disable-cli-telemetry.mjs')).href
  const { applyCliTelemetryDisabled: applyFromNextConfig } = await import(helperUrl)
  for (const flag of [undefined, '1']) {
    const env: Record<string, string | undefined> = {
      HITLY_TELEMETRY: flag,
      NEXT_TELEMETRY_DISABLED: '0',
      TURBO_TELEMETRY_DISABLED: '0',
    }
    applyFromNextConfig(env)
    assert.equal(env.NEXT_TELEMETRY_DISABLED, '1', `HITLY_TELEMETRY=${String(flag)}`)
    assert.equal(env.TURBO_TELEMETRY_DISABLED, '1', `HITLY_TELEMETRY=${String(flag)}`)
  }
})
