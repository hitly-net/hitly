/**
 * Tier entitlements helper, no-database half: fail-closed behaviour.
 *
 * DATABASE_URL is deleted before the module loads (each test file runs in
 * its own process), so the shared `db` singleton is null — the exact state
 * of a misconfigured server. Everything must deny, with one value-free log
 * line each.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

delete process.env.DATABASE_URL

type Helper = typeof import('./tier-entitlements')

async function helper(): Promise<Helper> {
  return import('./tier-entitlements')
}

function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return { lines, restore: () => (console.warn = original) }
}

describe('tier entitlements fail-closed without a database', () => {
  it('can() denies every feature and logs once', async () => {
    const { can } = await helper()
    const { lines, restore } = captureWarnings()
    try {
      assert.equal(await can({ plan: 'enterprise' }, 'mfa'), false)
      assert.equal(await can({ plan: 'enterprise' }, 'sso_google'), false)
      assert.equal(await can({ plan: 'enterprise' }, 'not_a_feature'), false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 3)
    for (const line of lines) {
      assert.match(line, /\[hitly entitlements\]/)
      assert.match(line, /database unavailable/)
    }
  })

  it('canForCurrentWorkspace denies when there is no current workspace and logs once', async () => {
    const { canForCurrentWorkspace } = await helper()
    const { lines, restore } = captureWarnings()
    try {
      const denied = await canForCurrentWorkspace('mfa', {
        resolveWorkspace: async () => null,
      })
      assert.equal(denied, false)
    } finally {
      restore()
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /no current workspace; denied "mfa"/)
  })

  it('getEntitlementsForWorkspace denies everything without a database', async () => {
    const { getEntitlementsForWorkspace } = await helper()
    const { restore } = captureWarnings()
    try {
      const features = await getEntitlementsForWorkspace({ plan: 'enterprise' })
      for (const value of Object.values(features)) assert.equal(value, false)
      assert.ok(Object.keys(features).length >= 8)
    } finally {
      restore()
    }
  })
})
