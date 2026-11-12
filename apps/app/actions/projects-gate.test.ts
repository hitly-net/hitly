/**
 * Action-path tests for the unverified-email gate (M2, hitly#164).
 *
 * These run the REAL server action functions with mocked tenant context and
 * mocked lib chokepoints whose fakes deliberately WRITE FIRST and gate
 * SECOND (the mutant ordering from review). Because the simulated tenant
 * transaction commits on a normal return and rolls back on a throw (exactly
 * like lib/tenant.ts withTenant), these tests fail if an action swallows the
 * gate error inside the transaction (writes commit), and pass only if the
 * gate error throws out of withAppTenant (rollback) and is converted to the
 * typed email_not_verified result outside it.
 *
 * Requires --experimental-test-module-mocks (enabled in the package test script).
 */

import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import {
  fakeDb,
  projectCreateFakes,
  sim,
  withFlag,
} from '../lib/gate-action-test-harness'
import { EMAIL_NOT_VERIFIED_CODE, VerifiedEmailRequiredError } from '../lib/verified-gate'

// ---- module mocks (registered before the action module is imported) ----

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('next/navigation', {
  namedExports: {
    redirect: (url: string) => {
      throw { digest: `NEXT_REDIRECT;replace;${url};307;` }
    },
  },
})
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
mock.module(new URL('../lib/project-create.ts', import.meta.url).href, { namedExports: projectCreateFakes })
mock.module(new URL('../lib/rbac.ts', import.meta.url).href, {
  namedExports: {
    canManageWorkspace: () => true,
    canAdminProject: () => true,
    canDecide: () => true,
    getProjectAccess: async () => ({ project: { workspaceId: sim.ctx.workspace.id, status: 'active' }, role: 'admin' }),
  },
})
mock.module(new URL('../lib/member-guard.ts', import.meta.url).href, {
  namedExports: { guardProjectAdminChange: async () => undefined },
})
mock.module(new URL('../lib/project-config.ts', import.meta.url).href, {
  namedExports: { parseProjectConfig: () => ({}), saveProjectConfig: async () => ({}) },
})
mock.module(new URL('../lib/project-lifecycle.ts', import.meta.url).href, {
  namedExports: {
    deleteProject: async () => undefined,
    mutationBlockedForProjectStatus: () => null,
    setProjectStatus: async () => undefined,
  },
})
mock.module(new URL('../lib/answer-form-helpers.ts', import.meta.url).href, {
  namedExports: { parseAnswerField: () => null },
})
mock.module(new URL('../lib/request-client.ts', import.meta.url).href, {
  namedExports: { clientFromHeaders: async () => ({}) },
})

let actions: typeof import('../actions/projects')
before(async () => {
  actions = await import('../actions/projects')
})

// ---- helpers ----

const ACTOR = sim.ctx.user.id

function expectTypedBlocked(result: unknown): void {
  assert.equal(typeof result, 'object')
  const value = result as { status?: unknown; code?: unknown; message?: unknown }
  assert.equal(value.status, 'error')
  assert.equal(value.code, EMAIL_NOT_VERIFIED_CODE)
  assert.match(String(value.message), /Verify your email/i)
}

beforeEach(() => sim.reset())

describe('unverified-email gate: action-path rollback (createProject)', () => {
  it('flag ON + unverified: typed result, gate error throws OUT of the transaction, 0 project rows committed', async () => {
    sim.verified.set(ACTOR, false)
    await withFlag('1', async () => {
      const formData = new FormData()
      formData.set('name', 'Blocked project')
      const result = await actions.createProject(formData)
      expectTypedBlocked(result)
      assert.equal(sim.projects.length, 0, 'no project row after refusal')
      assert.deepEqual(
        sim.committed.filter((op) => op.startsWith('project:')),
        [],
        'the transaction COMMITTED no project write (it rolled back)',
      )
      assert.equal(sim.writeJournal.length, 0, 'no pending writes left behind')
    })
  })

  it('flag ON + verified: commit happens, redirect passes through unmapped', async () => {
    sim.verified.set(ACTOR, true)
    await withFlag('1', async () => {
      const formData = new FormData()
      formData.set('name', 'Good project')
      await assert.rejects(
        () => actions.createProject(formData),
        (error: unknown) => String((error as { digest?: string }).digest).startsWith('NEXT_REDIRECT'),
        'redirect must propagate, not become a typed result',
      )
      assert.equal(sim.projects.length, 1, 'success path committed the project')
      assert.equal(sim.projects[0].by, ACTOR, 'created by the acting user')
    })
  })

  it('flag OFF + unverified: unchanged behaviour — commit succeeds', async () => {
    sim.verified.set(ACTOR, false)
    const formData = new FormData()
    formData.set('name', 'Flag-off project')
    await assert.rejects(() => actions.createProject(formData), (error: unknown) =>
      String((error as { digest?: string }).digest).startsWith('NEXT_REDIRECT'),
    )
    assert.equal(sim.projects.length, 1)
  })

  it('a text-preserving plain throw (gate text, wrong type) must NOT become the typed result', async () => {
    sim.verified.set(ACTOR, false)
    sim.plainTextThrow = true
    await withFlag('1', async () => {
      const formData = new FormData()
      formData.set('name', 'Text-throw project')
      await assert.rejects(
        () => actions.createProject(formData),
        (error: unknown) => error instanceof Error && !(error instanceof VerifiedEmailRequiredError) && /email_not_verified/.test(error.message),
        'only the real gate error class maps to the typed result',
      )
      assert.equal(sim.projects.length, 0, 'the error still rolled the transaction back')
    })
  })
})

describe('unverified-email gate: action-path rollback (API keys)', () => {
  it('flag ON + unverified: key create typed result, no key row committed, actor id forwarded', async () => {
    sim.verified.set(ACTOR, false)
    await withFlag('1', async () => {
      const formData = new FormData()
      formData.set('name', 'Blocked key')
      const result = await actions.createProjectApiKey('prj_x', formData)
      expectTypedBlocked(result)
      assert.equal(sim.keys.size, 0, 'no key row after refusal')
      assert.deepEqual(sim.committed.filter((op) => op.startsWith('key:')), [], 'no key write COMMITTED')
      const call = sim.calls.find((c) => c.fn === 'insertNewProjectApiKey')
      assert.equal(call?.args.userId, ACTOR, 'the acting user (not another actor) is checked and stored')
    })
  })

  it('flag ON + unverified: regenerate typed result, stored key hash UNCHANGED, no rotate committed', async () => {
    sim.verified.set(ACTOR, false)
    sim.seedKey({ id: 'k1', projectId: 'prj_x', hashed: 'orig_hash', prefix: 'hitly_orig' })
    await withFlag('1', async () => {
      const result = await actions.regenerateProjectApiKey('prj_x', 'k1')
      expectTypedBlocked(result)
      assert.equal(sim.keys.get('k1')!.hashed, 'orig_hash', 'refused rotate rolled back; old secret still stored')
      assert.deepEqual(sim.committed.filter((op) => op.startsWith('rotate:')), [], 'no rotate COMMITTED')
      const call = sim.calls.find((c) => c.fn === 'rotateProjectApiKeyRecord')
      assert.equal(call?.args.userId, ACTOR, 'rotate is gated on the acting user')
    })
  })

  it('flag ON + verified: key create and regenerate commit and return the raw key', async () => {
    sim.verified.set(ACTOR, true)
    sim.seedKey({ id: 'k2', projectId: 'prj_x', hashed: 'orig_hash2', prefix: 'hitly_or2' })
    await withFlag('1', async () => {
      const formData = new FormData()
      formData.set('name', 'Good key')
      const created = await actions.createProjectApiKey('prj_x', formData)
      assert.equal((created as { apiKey?: string }).apiKey?.startsWith('hitly_'), true)
      assert.ok(sim.committed.some((op) => op.startsWith('key:')), 'create committed')

      const rotated = await actions.regenerateProjectApiKey('prj_x', 'k2')
      assert.equal((rotated as { apiKey?: string }).apiKey?.startsWith('hitly_'), true)
      assert.notEqual(sim.keys.get('k2')!.hashed, 'orig_hash2', 'verified rotate applied')
      assert.ok(sim.committed.some((op) => op === 'rotate:k2'))
    })
  })

  it('flag OFF + unverified: key create and regenerate behave exactly as before', async () => {
    sim.verified.set(ACTOR, false)
    sim.seedKey({ id: 'k3', projectId: 'prj_x', hashed: 'orig_hash3', prefix: 'hitly_or3' })
    const formData = new FormData()
    formData.set('name', 'Off key')
    const created = await actions.createProjectApiKey('prj_x', formData)
    assert.equal((created as { apiKey?: string }).apiKey?.startsWith('hitly_'), true)
    const rotated = await actions.regenerateProjectApiKey('prj_x', 'k3')
    assert.equal((rotated as { apiKey?: string }).apiKey?.startsWith('hitly_'), true)
    assert.notEqual(sim.keys.get('k3')!.hashed, 'orig_hash3')
  })

  it('a text-preserving plain throw from the chokepoint propagates (no typed mapping)', async () => {
    sim.verified.set(ACTOR, false)
    sim.plainTextThrow = true
    sim.seedKey({ id: 'k9', projectId: 'prj_x', hashed: 'orig_hash9', prefix: 'hitly_or9' })
    await withFlag('1', async () => {
      await assert.rejects(
        () => actions.regenerateProjectApiKey('prj_x', 'k9'),
        (error: unknown) => error instanceof Error && !(error instanceof VerifiedEmailRequiredError),
      )
      assert.equal(sim.keys.get('k9')!.hashed, 'orig_hash9', 'plain throw also rolled back')
    })
  })
})
