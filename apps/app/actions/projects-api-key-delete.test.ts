/**
 * Action-path test for the API-key cap release (hitly#181 C6):
 * deleting a key must actually delete its row — apiKeyCount counts live
 * rows only, so a delete that failed to persist would keep the slot taken.
 *
 * Companion to projects-tier-api-keys.test.ts (which pins the create path).
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fakeDb, sim } from '../lib/gate-action-test-harness'

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

// Wraps the harness db to observe delete statements (the fake chain is a no-op).
const deletes: Array<{ table: unknown }> = []
const countingDb = {
  ...fakeDb,
  delete: (table: unknown) => {
    deletes.push({ table })
    return { where: async () => undefined }
  },
}

mock.module(new URL('../lib/tenant.ts', import.meta.url).href, {
  namedExports: {
    withTenant: <T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> => sim.runTx(fn),
    requireDb: () => countingDb,
    requireTenantWorkspaceId: () => sim.ctx.workspace.id,
  },
})
mock.module(new URL('../lib/require-db.ts', import.meta.url).href, { namedExports: { requireDb: () => countingDb } })
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

let actions: typeof import('../actions/projects')
before(async () => {
  actions = await import('../actions/projects')
})
beforeEach(() => {
  sim.reset()
  deletes.length = 0
  sim.nextRows = [{ id: 'key_existing' }]
  sim.seedKey({ id: 'key_existing', projectId: 'prj_x', hashed: 'h0', prefix: 'hitly_old' })
})

describe('deleteProjectApiKey', () => {
  it('issues a real delete on the API-key table so the cap slot is freed', async () => {
    await actions.deleteProjectApiKey('prj_x', 'key_existing')
    assert.equal(deletes.length, 1, 'deleting a key must delete its row (a key that still counts keeps the slot)')
    const table = deletes[0]?.table as Record<symbol, unknown> | undefined
    assert.equal(table?.[Symbol.for('drizzle:Name')], 'project_api_keys')
  })
})
