/**
 * Pure unit tests for the account-deletion decision core.
 *
 * These are the guards the deletion flow stands on, so each one is asserted
 * from both sides (accepts the legitimate case, refuses the near-miss) — the
 * mutation checks in the PR notes flip exactly these behaviours.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELETED_USER_LABEL,
  DEFAULT_SECURITY_EVENT_RETENTION_DAYS,
  anonymiseDecisionContext,
  blockedWorkspaceMessage,
  contextCarriesIdentity,
  hasActivePaidSubscriptionOwned,
  isDeletionConfirmation,
  planAccountDeletion,
  resolveSecurityEventHmacKey,
  securityEventHmac,
  securityEventRetentionDays,
  securityEventRetentionExpiresAt,
  shouldNotifyWorkspaceAdmin,
  truncateIpAddress,
  blocksAsSoleOwnerOfShared,
  type DeletionWorkspaceInput,
} from './account-deletion-plan'

function workspace(overrides: Partial<DeletionWorkspaceInput> = {}): DeletionWorkspaceInput {
  return {
    id: overrides.id ?? 'ws-1',
    name: overrides.name ?? 'Workspace',
    role: overrides.role ?? 'owner',
    memberCount: overrides.memberCount ?? 1,
    soleOwner: overrides.soleOwner ?? true,
    plan: overrides.plan ?? 'self-hosted',
    stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
  }
}

describe('typed confirmation', () => {
  it('accepts the word exactly (surrounding whitespace tolerated)', () => {
    assert.equal(isDeletionConfirmation('DELETE'), true)
    assert.equal(isDeletionConfirmation('  DELETE  '), true)
  })

  it('refuses every near-miss', () => {
    assert.equal(isDeletionConfirmation('delete'), false)
    assert.equal(isDeletionConfirmation('Delete'), false)
    assert.equal(isDeletionConfirmation('DELETEX'), false)
    assert.equal(isDeletionConfirmation('DELETE DELETE'), false)
    assert.equal(isDeletionConfirmation('DEL ET E'), false)
    assert.equal(isDeletionConfirmation(''), false)
    assert.equal(isDeletionConfirmation(undefined), false)
    assert.equal(isDeletionConfirmation(null), false)
    assert.equal(isDeletionConfirmation(true), false)
    assert.equal(isDeletionConfirmation(['DELETE']), false)
  })
})

describe('workspace classification', () => {
  it('deletes a workspace whose only member is this user', () => {
    const plan = planAccountDeletion([workspace({ memberCount: 1 })])
    assert.deepEqual(plan.deletableWorkspaces, [{ id: 'ws-1', name: 'Workspace' }])
    assert.deepEqual(plan.keptWorkspaces, [])
    assert.equal(plan.hasBlocker, false)
  })

  it('blocks a shared workspace the user alone owns', () => {
    const plan = planAccountDeletion([workspace({ memberCount: 3, role: 'owner', soleOwner: true })])
    assert.equal(plan.hasBlocker, true)
    assert.deepEqual(plan.blockedWorkspaces, [{ id: 'ws-1', name: 'Workspace', reason: 'sole_owner_of_shared' }])
    assert.deepEqual(plan.deletableWorkspaces, [])
  })

  it('keeps a shared workspace where another owner exists', () => {
    const plan = planAccountDeletion([workspace({ memberCount: 3, role: 'owner', soleOwner: false })])
    assert.equal(plan.hasBlocker, false)
    assert.deepEqual(plan.keptWorkspaces, [{ id: 'ws-1', name: 'Workspace', role: 'owner' }])
  })

  it('keeps a shared workspace the user merely belongs to', () => {
    const plan = planAccountDeletion([workspace({ memberCount: 2, role: 'member', soleOwner: false })])
    assert.equal(plan.hasBlocker, false)
    assert.deepEqual(plan.keptWorkspaces, [{ id: 'ws-1', name: 'Workspace', role: 'member' }])
  })

  it('never deletes a single-member workspace it also blocks', () => {
    const plan = planAccountDeletion([
      workspace({ id: 'ws-paid', memberCount: 1, plan: 'pro', stripeSubscriptionId: 'sub_1' }),
    ])
    assert.equal(plan.hasBlocker, true)
    assert.deepEqual(plan.blockedWorkspaces, [{ id: 'ws-paid', name: 'Workspace', reason: 'active_subscription' }])
    assert.deepEqual(plan.deletableWorkspaces, [])
  })

  it('mixes buckets correctly', () => {
    const plan = planAccountDeletion([
      workspace({ id: 'solo', memberCount: 1 }),
      workspace({ id: 'shared-member', memberCount: 4, role: 'member', soleOwner: false }),
      workspace({ id: 'shared-owner', memberCount: 2, role: 'owner', soleOwner: true }),
    ])
    assert.deepEqual(
      plan.deletableWorkspaces.map((item) => item.id),
      ['solo'],
    )
    assert.deepEqual(
      plan.keptWorkspaces.map((item) => item.id),
      ['shared-member'],
    )
    assert.deepEqual(
      plan.blockedWorkspaces.map((item) => item.id),
      ['shared-owner'],
    )
  })

  it('a lone owner of a single-member workspace is not a blocker', () => {
    // memberCount 1 means "no other members", which is the delete-with-account
    // ruling; the 409 exists only for workspaces that have OTHER members.
    assert.equal(blocksAsSoleOwnerOfShared(workspace({ memberCount: 1, role: 'owner', soleOwner: true })), false)
    assert.equal(blocksAsSoleOwnerOfShared(workspace({ memberCount: 2, role: 'owner', soleOwner: true })), true)
    assert.equal(blocksAsSoleOwnerOfShared(workspace({ memberCount: 2, role: 'admin', soleOwner: true })), false)
  })
})

describe('active paid subscription', () => {
  it('blocks only an owned workspace with a subscription on a paid plan', () => {
    assert.equal(hasActivePaidSubscriptionOwned(workspace({ plan: 'pro', stripeSubscriptionId: 'sub_1' })), true)
    assert.equal(hasActivePaidSubscriptionOwned(workspace({ plan: 'team', stripeSubscriptionId: 'sub_1' })), true)
    assert.equal(hasActivePaidSubscriptionOwned(workspace({ plan: 'self-hosted', stripeSubscriptionId: 'sub_1' })), false)
    assert.equal(hasActivePaidSubscriptionOwned(workspace({ plan: 'pro', stripeSubscriptionId: null })), false)
    assert.equal(
      hasActivePaidSubscriptionOwned(workspace({ plan: 'pro', stripeSubscriptionId: 'sub_1', role: 'member' })),
      false,
    )
  })

  it('tells the user to cancel the subscription first', () => {
    assert.match(blockedWorkspaceMessage('active_subscription'), /Cancel your subscription first/)
    assert.match(blockedWorkspaceMessage('sole_owner_of_shared'), /other members/)
  })
})

describe('who must be emailed about a departing member', () => {
  it('notifies owners and admins only', () => {
    assert.equal(shouldNotifyWorkspaceAdmin('owner'), true)
    assert.equal(shouldNotifyWorkspaceAdmin('admin'), true)
    assert.equal(shouldNotifyWorkspaceAdmin('member'), false)
    assert.equal(shouldNotifyWorkspaceAdmin('viewer'), false)
  })
})

describe('security-event retention', () => {
  it('defaults to 90 days and accepts a sane override', () => {
    assert.equal(securityEventRetentionDays({}), DEFAULT_SECURITY_EVENT_RETENTION_DAYS)
    assert.equal(DEFAULT_SECURITY_EVENT_RETENTION_DAYS, 90)
    assert.equal(securityEventRetentionDays({ HITLY_SECURITY_EVENT_RETENTION_DAYS: '30' }), 30)
    assert.equal(securityEventRetentionDays({ HITLY_SECURITY_EVENT_RETENTION_DAYS: ' 7 ' }), 7)
  })

  it('falls back to the default for nonsense, zero and out-of-range', () => {
    for (const value of ['0', '-5', 'abc', '1.5', '99999', '']) {
      assert.equal(
        securityEventRetentionDays({ HITLY_SECURITY_EVENT_RETENTION_DAYS: value }),
        DEFAULT_SECURITY_EVENT_RETENTION_DAYS,
        `value ${JSON.stringify(value)} must fall back`,
      )
    }
  })

  it('computes the deadline from the window', () => {
    const now = 1_700_000_000_000
    assert.equal(securityEventRetentionExpiresAt(1, now).getTime(), now + 24 * 60 * 60 * 1000)
    assert.equal(securityEventRetentionExpiresAt(90, now).getTime(), now + 90 * 24 * 60 * 60 * 1000)
  })
})

describe('security-event HMACs', () => {
  it('is deterministic, keyed and value-free', () => {
    const a = securityEventHmac('key-one-0123456789abcdef', 'user-42')
    const b = securityEventHmac('key-one-0123456789abcdef', 'user-42')
    const c = securityEventHmac('key-two-0123456789abcdef', 'user-42')
    const d = securityEventHmac('key-one-0123456789abcdef', 'user-43')
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.notEqual(a, d)
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.ok(!a.includes('user-42'))
  })

  it('resolves the operator key, else the auth secret, else refuses', () => {
    assert.equal(
      resolveSecurityEventHmacKey({ HITLY_SECURITY_EVENT_HMAC_KEY: 'operator-key-0123456789' }),
      'operator-key-0123456789',
    )
    assert.equal(
      resolveSecurityEventHmacKey({ BETTER_AUTH_SECRET: 'auth-secret-0123456789abcdef' }),
      'auth-secret-0123456789abcdef',
    )
    assert.throws(() => resolveSecurityEventHmacKey({ HITLY_SECURITY_EVENT_HMAC_KEY: 'short' }))
    assert.throws(() => resolveSecurityEventHmacKey({}))
  })
})

describe('client address truncation', () => {
  it('keeps only the /24 of an IPv4 address', () => {
    assert.equal(truncateIpAddress('203.0.113.84'), '203.0.113.0')
    assert.equal(truncateIpAddress('198.51.100.7'), '198.51.100.0')
    assert.equal(truncateIpAddress('0.0.0.0'), '0.0.0.0')
  })

  it('keeps only the /64 of an IPv6 address', () => {
    assert.equal(truncateIpAddress('2001:db8:1:2:abcd:ef01:2345:6789'), '2001:db8:1:2::')
    assert.equal(truncateIpAddress('2001:db8:1:2::abcd'), '2001:db8:1:2::')
    assert.equal(truncateIpAddress('::1'), '0:0:0:0::')
  })

  it('never stores an unparseable address', () => {
    assert.equal(truncateIpAddress('not-an-ip'), null)
    assert.equal(truncateIpAddress('203.0.113.999'), null)
    assert.equal(truncateIpAddress(''), null)
    assert.equal(truncateIpAddress(null), null)
    assert.equal(truncateIpAddress(undefined), null)
  })
})

describe('decision-record anonymisation', () => {
  const stored = {
    actor: { kind: 'human', id: 'usr-secret-1', display: 'Dana Reviewer' },
    client: { channel: 'web', platform: 'ios', appVersion: '9.9.9', userAgent: 'Mozilla/5.0 (iPhone)' },
  }

  it('drops the identity and the device, keeps the channel', () => {
    const result = anonymiseDecisionContext(stored)
    assert.deepEqual(result.actor, { kind: 'human', display: DELETED_USER_LABEL })
    assert.deepEqual(result.client, { channel: 'web' })
    assert.equal(contextCarriesIdentity(result), false)
  })

  it('never re-emits the user id, name, email or user agent', () => {
    const result = anonymiseDecisionContext({
      actor: { kind: 'human', id: 'usr-secret-1', display: 'dana@example.com' },
      client: { channel: 'mobile', userAgent: 'Mozilla/5.0 (iPhone)' },
    })
    const text = JSON.stringify(result)
    assert.ok(!text.includes('usr-secret-1'))
    assert.ok(!text.includes('dana@example.com'))
    assert.ok(!text.includes('Mozilla'))
    assert.ok(!text.includes('userAgent'))
    assert.ok(!text.includes('appVersion'))
  })

  it('does not mutate the caller object and copes with junk', () => {
    const frozen = JSON.parse(JSON.stringify(stored))
    anonymiseDecisionContext(frozen)
    assert.deepEqual(frozen, stored)
    assert.deepEqual(anonymiseDecisionContext(null), {})
    assert.deepEqual(anonymiseDecisionContext(undefined), {})
    assert.deepEqual(anonymiseDecisionContext({}), {})
  })

  it('an untouched stored context still reads as carrying identity', () => {
    assert.equal(contextCarriesIdentity(stored), true)
  })
})
