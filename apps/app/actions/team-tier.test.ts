/**
 * Action-path tests for the seat cap: the single writer (lib/invites)
 * throws the typed TierLimitError OUT of the tenant transaction, so the
 * action converts it to the serialisable tier result AFTER the transaction
 * is discarded — the invite/membership writes must be rolled back and the
 * mail never sent. Only throw-out-for-rollback passes here.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fakeDb, sim } from '../lib/gate-action-test-harness'
import { TIER_LIMIT_CODE, TierLimitError } from '../lib/tier-enforcement'

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module(new URL('../lib/context.ts', import.meta.url).href, {
  namedExports: {
    getAppContext: async () => sim.ctx,
    withAppTenant: <T>(fn: (ctx: typeof sim.ctx) => Promise<T>): Promise<T> => sim.runTx(() => fn(sim.ctx)),
  },
})
mock.module(new URL('../lib/tenant.ts', import.meta.url).href, {
  namedExports: {
    withTenant: <T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> => sim.runTx(fn),
    requireDb: () => fakeDb,
    requireTenantWorkspaceId: () => sim.ctx.workspace.id,
  },
})
mock.module(new URL('../lib/require-db.ts', import.meta.url).href, { namedExports: { requireDb: () => fakeDb } })

const refusal = {
  code: TIER_LIMIT_CODE,
  limitKey: 'seats' as const,
  message: 'Seat limit reached (2 of 2 seats in use, counting members and pending invites). Remove a person or upgrade to add more.',
  limit: 2,
  usage: 2,
}

mock.module(new URL('../lib/invites.ts', import.meta.url).href, {
  namedExports: {
    // WRITE FIRST, gate SECOND (mutant ordering): committing on a normal
    // return would leave an invite row behind, so only the throw path passes.
    createAndSendWorkspaceInvite: async (args: { email: string }) => {
      sim.record(`invite:${args.email}`, () => {
        sim.invites.push({ id: `inv_${sim.seq++}`, email: args.email, tokenHash: 'x', actorUserId: sim.ctx.user.id })
        sim.inviteSendCount += 1
      })
      throw new TierLimitError(refusal)
    },
    addExistingUserToWorkspace: async (args: { userId: string }) => {
      sim.record(`member:${args.userId}`, () => {
        sim.memberships.push({ id: `mem_${sim.seq++}`, workspaceId: sim.ctx.workspace.id, userId: args.userId, role: 'member' })
      })
      throw new TierLimitError(refusal)
    },
    resendWorkspaceInvite: async () => ({ ok: true as const, expiresAt: new Date() }),
    revokeWorkspaceInvite: async () => true,
  },
})
mock.module(new URL('../lib/rbac.ts', import.meta.url).href, {
  namedExports: {
    canManageWorkspace: () => true,
    getProjectAccess: async () => null,
    canAdminProject: () => false,
    canDecide: () => false,
  },
})
mock.module(new URL('../lib/member-guard.ts', import.meta.url).href, {
  namedExports: {
    assertWorkspaceKeepsOwner: async () => undefined,
    assertWorkspaceMemberRemovalKeepsProjectAdmins: async () => undefined,
  },
})
mock.module(new URL('../lib/workspace.ts', import.meta.url).href, {
  namedExports: {
    findUserByEmail: async (email: string) => (email === 'existing@te.invalid' ? { id: 'usr_existing', email } : null),
    listUserWorkspaces: async () => [],
    bootstrapUserWorkspaces: async () => undefined,
  },
})
mock.module(new URL('../lib/mail.ts', import.meta.url).href, {
  namedExports: { sendMail: async () => ({ delivered: true as const }) },
})

let actions: typeof import('../actions/team')
before(async () => {
  actions = await import('../actions/team')
})
beforeEach(() => sim.reset())

function formData(email: string): FormData {
  const data = new FormData()
  data.set('email', email)
  data.set('role', 'member')
  return data
}

describe('inviteToWorkspace seat-cap refusal', () => {
  it('a new-address invite over the cap returns the typed refusal and commits nothing', async () => {
    const result = await actions.inviteToWorkspace(formData('new@te.invalid'))
    assert.deepEqual(result, { status: 'error', code: TIER_LIMIT_CODE, limitKey: 'seats', message: refusal.message })
    assert.equal(sim.committed.length, 0, `nothing may commit: ${sim.committed.join(',')}`)
    assert.equal(sim.inviteSendCount, 0, 'no invite mail on a refused send')
    assert.equal(sim.invites.length, 0)
  })

  it('an existing-user add over the cap returns the typed refusal and commits no membership', async () => {
    sim.nextRows = [] // the action's membership pre-check must find no existing row
    const result = await actions.inviteToWorkspace(formData('existing@te.invalid'))
    assert.deepEqual(result, { status: 'error', code: TIER_LIMIT_CODE, limitKey: 'seats', message: refusal.message })
    assert.equal(sim.committed.length, 0)
    assert.equal(sim.memberships.length, 0)
  })

  it('a non-tier error still propagates (the refusal mapping stays narrow)', async () => {
    await assert.rejects(() => {
      // No email: the action's own validation throws before any writer.
      return actions.inviteToWorkspace(new FormData())
    }, /Email is required/)
  })
})
