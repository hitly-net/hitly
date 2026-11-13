import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ENTITLEMENT_FEATURES,
  TIER_ENTITLEMENT_SEED,
  WORKSPACE_PLANS,
  canFromMap,
  isEntitlementFeature,
  planRank,
  seedAsMap,
  ssoFeatureForProvider,
} from './index.ts'

/**
 * Tier entitlements map — seed rules, deny policy, and the property that
 * a data change (not a code change) moves a feature between tiers.
 */

function collectLog(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = []
  return { lines, log: (line: string) => lines.push(line) }
}

const ALL_PLANS = WORKSPACE_PLANS as readonly string[]

describe('tier entitlements seed', () => {
  it('MFA is available on every plan', () => {
    const { log } = collectLog()
    for (const plan of ALL_PLANS) {
      assert.equal(canFromMap(seedAsMap(), { plan }, 'mfa', log), true, plan)
    }
  })

  it('Google/Gmail SSO requires Team or above', () => {
    const { log } = collectLog()
    for (const plan of ALL_PLANS) {
      const expected = plan === 'team' || plan === 'enterprise'
      assert.equal(canFromMap(seedAsMap(), { plan }, 'sso_google', log), expected, plan)
    }
  })

  it('Slack SSO requires Team or above', () => {
    const { log } = collectLog()
    for (const plan of ALL_PLANS) {
      const expected = plan === 'team' || plan === 'enterprise'
      assert.equal(canFromMap(seedAsMap(), { plan }, 'sso_slack', log), expected, plan)
    }
  })

  for (const feature of ['sso_microsoft', 'sso_github', 'sso_saml', 'sso'] as const) {
    it(`${feature} requires Enterprise`, () => {
      const { log } = collectLog()
      for (const plan of ALL_PLANS) {
        assert.equal(canFromMap(seedAsMap(), { plan }, feature, log), plan === 'enterprise', plan)
      }
    })
  }

  it('project lifecycle is available on every plan', () => {
    const { log } = collectLog()
    for (const plan of ALL_PLANS) {
      assert.equal(canFromMap(seedAsMap(), { plan }, 'project_lifecycle', log), true, plan)
    }
  })

  it('the seed covers exactly the registered feature set', () => {
    assert.deepEqual(
      Object.keys(TIER_ENTITLEMENT_SEED).sort(),
      [...ENTITLEMENT_FEATURES].sort(),
    )
  })
})

describe('tier entitlements deny policy', () => {
  it('unknown feature denies and logs', () => {
    const { lines, log } = collectLog()
    assert.equal(canFromMap(seedAsMap(), { plan: 'enterprise' }, 'free_limbo', log), false)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /unknown feature "free_limbo"/)
    assert.match(lines[0], /denied/)
  })

  it('a removed row denies and logs', () => {
    const map = seedAsMap()
    map.delete('mfa')
    const { lines, log } = collectLog()
    assert.equal(canFromMap(map, { plan: 'enterprise' }, 'mfa', log), false)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /no entitlement row for "mfa"/)
  })

  it('an unknown plan denies and logs', () => {
    const { lines, log } = collectLog()
    assert.equal(canFromMap(seedAsMap(), { plan: 'limbo' }, 'mfa', log), false)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /unknown workspace plan "limbo"/)
  })

  it('an unknown min_plan in the map denies and logs', () => {
    const map = seedAsMap()
    map.set('mfa', 'limbo')
    const { lines, log } = collectLog()
    assert.equal(canFromMap(map, { plan: 'enterprise' }, 'mfa', log), false)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /unknown min_plan "limbo" for "mfa"/)
  })

  it('an allow path logs nothing', () => {
    const { lines, log } = collectLog()
    assert.equal(canFromMap(seedAsMap(), { plan: 'team' }, 'sso_google', log), true)
    assert.equal(lines.length, 0)
  })
})

describe('tier entitlements are data, not code', () => {
  it('moving a feature to a lower tier changes the result with no code change', () => {
    const { log } = collectLog()
    const map = seedAsMap()
    assert.equal(canFromMap(map, { plan: 'solo' }, 'sso_google', log), false)
    // Exactly what `UPDATE tier_entitlements SET min_plan = 'solo'
    // WHERE feature = 'sso_google'` produces.
    map.set('sso_google', 'solo')
    assert.equal(canFromMap(map, { plan: 'solo' }, 'sso_google', log), true)
    assert.equal(canFromMap(map, { plan: 'pro' }, 'sso_google', log), true)
  })

  it('moving a feature to a higher tier revokes it below the new floor', () => {
    const { log } = collectLog()
    const map = seedAsMap()
    assert.equal(canFromMap(map, { plan: 'team' }, 'mfa', log), true)
    map.set('mfa', 'enterprise')
    assert.equal(canFromMap(map, { plan: 'team' }, 'mfa', log), false)
    assert.equal(canFromMap(map, { plan: 'enterprise' }, 'mfa', log), true)
  })

  it('planRank orders plans and rejects strangers', () => {
    assert.ok(planRank('solo') < planRank('pro'))
    assert.ok(planRank('pro') < planRank('team'))
    assert.ok(planRank('team') < planRank('enterprise'))
    assert.equal(planRank('limbo'), -1)
  })
})

describe('ssoFeatureForProvider', () => {
  it('maps known providers to their gated features', () => {
    assert.equal(ssoFeatureForProvider('google'), 'sso_google')
    assert.equal(ssoFeatureForProvider('gmail'), 'sso_google')
    assert.equal(ssoFeatureForProvider('Google'), 'sso_google')
    assert.equal(ssoFeatureForProvider('slack'), 'sso_slack')
    assert.equal(ssoFeatureForProvider('microsoft'), 'sso_microsoft')
    assert.equal(ssoFeatureForProvider('entra-id'), 'sso_microsoft')
    assert.equal(ssoFeatureForProvider('github'), 'sso_github')
    assert.equal(ssoFeatureForProvider('saml'), 'sso_saml')
  })

  it('unknown providers fall back to the generic SSO feature', () => {
    assert.equal(ssoFeatureForProvider('whatever-oidc'), 'sso')
    assert.equal(ssoFeatureForProvider(''), 'sso')
    assert.ok(isEntitlementFeature(ssoFeatureForProvider('whatever-oidc')))
  })
})
