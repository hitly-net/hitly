/**
 * Action-path tests for the workspace-invite gate (M2, hitly#164) — same
 * simulated-transaction design as actions/projects-gate.test.ts: the lib
 * invite fakes WRITE FIRST and gate SECOND, so an action that swallows the
 * gate error inside the tenant transaction would commit an invite row and
 * "send" the email; only throw-out-for-rollback passes.
 *
 * Requires --experimental-test-module-mocks (enabled in the package test script).
 */

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fakeDb, inviteFakes, sim, withFlag } from '../lib/gate-action-test-harness'
import { EMAIL_NOT_VERIFIED_CODE, VerifiedEmailRequiredError } from '../lib/verified-gate'

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
mock.module(new URL('../lib/invites.ts', import.meta.url).href, {
  namedExports: { ...inviteFakes, revokeWorkspaceInvite: async () => true },
})
mock.module(new URL('../lib/rbac.ts', import.meta.url).href, {
  namedExports: { canManageWorkspace: () => true, getProjectAccess: async () => null, canAdminProject: () => false, canDecide: () => false },
})
mock.module(new URL('../lib/member-guard.ts', import.meta.url).href, {
  namedExports: {
    assertWorkspaceKeepsOwner: async () => undefined,
    assertWorkspaceMemberRemovalKeepsProjectAdmins: async () => undefined,
  },
})
mock.module(new URL('../lib/workspace.ts', import.meta.url).href, {
  namedExports: { findUserByEmail: async () => null, listUserWorkspaces: async () => [], bootstrapUserWorkspaces: async () => undefined },
})
mock.module(new URL('../lib/mail.ts', import.meta.url).href, {
  namedExports: { sendMail: async () => ({ delivered: true as const }) },
})

let actions: typeof import('../actions/team')
before(async () => {
  actions = await import('../actions/team')
})

const ACTOR = sim.ctx.user.id

function expectTypedBlocked(result: unknown): void {
  assert.equal(typeof result, 'object')
  const value = result as { status?: unknown; code?: unknown; message?: unknown }
  assert.equal(value.status, 'error')
  assert.equal(value.code, EMAIL_NOT_VERIFIED_CODE)
  assert.match(String(value.message), /Verify your email/i)
}

function inviteForm(email = 'newbie@example.com'): FormData {
  const formData = new FormData()
  formData.set('email', email)
  formData.set('role', 'member')
  return formData
}

beforeEach(() => sim.reset())

describe('unverified-email gate: action-path rollback (invite send)', () => {
  it('flag ON + unverified: typed result, no invite row committed, no mail sent', async () => {
    sim.verified.set(ACTOR, false)
    await withFlag('1', async () => {
      const result = await actions.inviteToWorkspace(inviteForm())
      expectTypedBlocked(result)
      assert.equal(sim.invites.length, 0, 'no invite row after refusal')
      assert.deepEqual(sim.committed.filter((op) => op.startsWith('invite:')), [], 'no invite write COMMITTED')
      assert.equal(sim.inviteSendCount, 0, 'no invite email "sent"')
      const call = sim.calls.find((c) => c.fn === 'createAndSendWorkspaceInvite')
      assert.equal(call?.args.actorUserId, ACTOR, 'the acting user is the gate subject')
    })
  })

  it('flag ON + verified: invite commits and mails once', async () => {
    sim.verified.set(ACTOR, true)
    await withFlag('1', async () => {
      const result = await actions.inviteToWorkspace(inviteForm())
      assert.equal(result, undefined, 'success path unchanged')
      assert.equal(sim.invites.length, 1)
      assert.equal(sim.inviteSendCount, 1)
      assert.ok(sim.committed.some((op) => op.startsWith('invite:')))
    })
  })

  it('flag OFF + unverified: invite behaves exactly as before (commit + mail)', async () => {
    sim.verified.set(ACTOR, false)
    const result = await actions.inviteToWorkspace(inviteForm())
    assert.equal(result, undefined)
    assert.equal(sim.invites.length, 1)
    assert.equal(sim.inviteSendCount, 1)
  })

  it('a text-preserving plain throw (wrong error type) propagates and rolls back', async () => {
    sim.verified.set(ACTOR, false)
    sim.plainTextThrow = true
    await withFlag('1', async () => {
      await assert.rejects(
        () => actions.inviteToWorkspace(inviteForm()),
        (error: unknown) => error instanceof Error && !(error instanceof VerifiedEmailRequiredError) && /email_not_verified/.test(error.message),
      )
      assert.equal(sim.invites.length, 0)
    })
  })
})

describe('unverified-email gate: action-path rollback (invite resend)', () => {
  it('flag ON + unverified: typed result, existing token untouched, no rotate committed', async () => {
    sim.verified.set(ACTOR, false)
    sim.seedInvite({ id: 'inv_1', email: 'pending@example.com', tokenHash: 'tok_original', actorUserId: 'usr_creator' })
    await withFlag('1', async () => {
      const result = await actions.resendInvite('inv_1')
      expectTypedBlocked(result)
      assert.equal(sim.invites[0].tokenHash, 'tok_original', 'refused resend rolled the token rotation back')
      assert.deepEqual(sim.committed.filter((op) => op.startsWith('rotate-invite:')), [], 'no rotate COMMITTED')
      const call = sim.calls.find((c) => c.fn === 'resendWorkspaceInvite')
      assert.equal(call?.args.actorUserId, ACTOR, 'the acting user is the gate subject')
    })
  })

  it('flag ON + verified: resend commits a fresh token', async () => {
    sim.verified.set(ACTOR, true)
    sim.seedInvite({ id: 'inv_2', email: 'pending@example.com', tokenHash: 'tok_original', actorUserId: 'usr_creator' })
    await withFlag('1', async () => {
      const result = await actions.resendInvite('inv_2')
      assert.equal(result, undefined)
      assert.notEqual(sim.invites[0].tokenHash, 'tok_original')
      assert.ok(sim.committed.some((op) => op.startsWith('rotate-invite:')))
    })
  })

  it('flag OFF + unverified: resend behaves exactly as before', async () => {
    sim.verified.set(ACTOR, false)
    sim.seedInvite({ id: 'inv_3', email: 'pending@example.com', tokenHash: 'tok_original', actorUserId: 'usr_creator' })
    const result = await actions.resendInvite('inv_3')
    assert.equal(result, undefined)
    assert.notEqual(sim.invites[0].tokenHash, 'tok_original')
  })
})
