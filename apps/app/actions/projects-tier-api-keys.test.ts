/**
 * Action-path tests for the API-key cap (hitly#181 C8):
 *  - createProjectApiKey over the cap returns the typed refusal
 *    ({ status:'error', code:'tier_limit_reached', limitKey:'api_keys', message })
 *    and commits no key rows (the writer throws out of the tenant transaction);
 *  - hostile client fields (plan / limit) are ignored;
 *  - regenerateProjectApiKey at the cap is not a new use (the mocked rotate
 *    succeeds and does not throw a cap refusal).
 *
 * Requires the #175 surface (lib/tier-enforcement.ts). On that baseline this
 * file compiles and fails because createProjectApiKey only converts
 * toGateBlockedResult today.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fakeDb, sim } from '../lib/gate-action-test-harness'
import { TIER_LIMIT_CODE, TierLimitError } from '../lib/tier-enforcement'

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
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
mock.module(new URL('../lib/require-db.ts', import.meta.url).href, { namedExports: { requireDb: () => fakeDb } })
mock.module(new URL('../lib/events.ts', import.meta.url).href, {
  namedExports: { logProjectEvent: async () => undefined },
})
mock.module(new URL('../lib/rbac.ts', import.meta.url).href, {
  namedExports: {
    canManageWorkspace: () => true,
    canAdminProject: () => true,
    canDecide: () => true,
    getProjectAccess: async () => ({
      project: { workspaceId: sim.ctx.workspace.id, status: 'live' },
      role: 'admin',
    }),
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
    deleteProject: async () => ({ ok: true }),
    mutationBlockedForProjectStatus: () => null,
    ingestBlockedForProjectStatus: () => null,
    canUseProjectLifecycle: async () => true,
    setProjectStatus: async () => ({ ok: true, status: 'live' }),
  },
})
mock.module(new URL('../lib/resume-secret.ts', import.meta.url).href, {
  namedExports: { rotateProjectResumeSecret: async () => ({ resumeSecret: 'secret' }) },
})
mock.module(new URL('../lib/request-client.ts', import.meta.url).href, {
  namedExports: { clientFromHeaders: () => ({ channel: 'web' }) },
})

const keyRefusal = {
  code: TIER_LIMIT_CODE,
  limitKey: 'api_keys' as const,
  message: 'API key limit reached (2 of 2 API keys in use). Delete a key or upgrade to add more.',
  limit: 2,
  usage: 2,
}

let rotateThrows = false

mock.module(new URL('../lib/project-create.ts', import.meta.url).href, {
  namedExports: {
    assertCreatorVerified: async () => undefined,
    insertNewProject: async () => 'prj_x',
    // WRITE FIRST, gate SECOND (mutant ordering): only the throw-out-of-tx path passes.
    insertNewProjectApiKey: async (args: { name: unknown; projectId: string }) => {
      sim.record(`key:${String(args.name)}`, () => {
        const id = `key_${sim.seq++}`
        sim.keys.set(id, { id, projectId: args.projectId, hashed: 'h', prefix: 'hitly_sim' })
      })
      throw new TierLimitError(keyRefusal as never)
    },
    rotateProjectApiKeyRecord: async (args: { projectId: string; keyId: string }) => {
      sim.record(`rotate:${args.keyId}`, () => undefined)
      if (rotateThrows) throw new TierLimitError(keyRefusal as never)
      return 'hitly_rotated'
    },
  },
})

let actions: typeof import('../actions/projects')
before(async () => {
  actions = await import('../actions/projects')
})
beforeEach(() => {
  sim.reset()
  rotateThrows = false
  sim.nextRows = [{ id: 'key_existing' }]
  sim.seedKey({ id: 'key_existing', projectId: 'prj_x', hashed: 'h0', prefix: 'hitly_old' })
})

function keyForm(name = 'Ingest key', extras: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('name', name)
  for (const [k, v] of Object.entries(extras)) data.set(k, v)
  return data
}

describe('createProjectApiKey api_keys cap', () => {
  it('over the cap returns the typed refusal and commits no key rows', async () => {
    const result = await actions.createProjectApiKey('prj_x', keyForm())
    assert.deepEqual(result, {
      status: 'error',
      code: TIER_LIMIT_CODE,
      limitKey: 'api_keys',
      message: keyRefusal.message,
    })
    assert.equal(sim.committed.length, 0, `nothing may commit: ${sim.committed.join(',')}`)
    assert.equal(sim.keys.size, 1, 'the seeded key is the only row; the refused create must not land')
  })

  it('hostile client plan/limit fields do not change the refusal', async () => {
    const result = await actions.createProjectApiKey(
      'prj_x',
      keyForm('Ingest key', { plan: 'enterprise', limit: '9999', limitKey: 'seats' }),
    )
    assert.equal((result as { code?: string }).code, TIER_LIMIT_CODE)
    assert.equal((result as { limitKey?: string }).limitKey, 'api_keys')
    assert.equal(sim.committed.length, 0)
  })
})

describe('regenerateProjectApiKey is not new use', () => {
  it('rotation at the cap is not refused by the create-path mock', async () => {
    // rotateThrows stays false: rotation must not share the create refusal.
    const result = await actions.regenerateProjectApiKey('prj_x', 'key_existing')
    assert.deepEqual(result, { apiKey: 'hitly_rotated' })
  })
})
