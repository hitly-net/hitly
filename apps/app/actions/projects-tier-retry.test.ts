/**
 * Action-path test: retryWorkItem rides a tier (retention) refusal onto the
 * ?error= redirect so the reviewer sees the human message (never a 500).
 *
 * The action now imports retryResume from lib/approvals statically; node's
 * mock.module (as of the 22.23 module.registerHooks change, under the tsx
 * loader) intercepts static imports resolved after registration but not
 * runtime await-import() calls, so a static import is what makes this mock
 * effective deterministically. The suite lives in its own file so the
 * retry-flow mocks stay isolated from the create/resume suites in
 * projects-tier.test.ts.
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fakeDb, sim } from '../lib/gate-action-test-harness'
import { TIER_LIMIT_CODE } from '../lib/tier-enforcement'

const redirects: string[] = []

mock.module('next/cache', { namedExports: { revalidatePath: () => undefined } })
mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
mock.module('next/navigation', {
  namedExports: {
    redirect: (url: string) => {
      redirects.push(url)
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
mock.module(new URL('../lib/project-create.ts', import.meta.url).href, {
  namedExports: {
    assertCreatorVerified: async () => undefined,
    insertNewProject: async () => {
      throw new Error('unused in retry tests')
    },
    insertNewProjectApiKey: async () => ({ id: 'key_x', raw: 'hitly_raw' }),
    rotateProjectApiKeyRecord: async () => ({ id: 'key_x', raw: 'hitly_raw' }),
  },
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

const retentionRefusal = {
  code: TIER_LIMIT_CODE,
  limitKey: 'completed_retention_days' as const,
  message: "This item is 12 days old — past your plan's 10-day retention for completed items. Upgrade to extend retention.",
  limit: 10,
  usage: 12,
}

let retryResumeImpl: () => Promise<{ error?: string; code?: string; status?: number }> = async () => ({})

mock.module(new URL('../lib/approvals.ts', import.meta.url).href, {
  namedExports: {
    retryResume: async () => retryResumeImpl(),
  },
})

let actions: typeof import('../actions/projects')
before(async () => {
  actions = await import('../actions/projects')
})

beforeEach(() => {
  sim.reset()
  redirects.length = 0
  retryResumeImpl = async () => ({})
})

describe('retryWorkItem retention refusal', () => {
  it('redirects to the work item with the human refusal message as ?error= (never a 500)', async () => {
    sim.nextRows = [{ id: 'apr_x', projectId: 'prj_x', workspaceId: sim.ctx.workspace.id }]
    retryResumeImpl = async () => ({ error: retentionRefusal.message, code: TIER_LIMIT_CODE, status: 402 })
    await assert.rejects(
      () => actions.retryWorkItem('apr_x'),
      (error: unknown) => typeof error === 'object' && error !== null && 'digest' in error,
    )
    assert.equal(redirects.length, 1)
    assert.match(redirects[0], /^\/inbox\/apr_x\?error=/)
    assert.ok(
      decodeURIComponent(redirects[0]).includes(retentionRefusal.message),
      'the human retention message must reach the UI',
    )
  })

  it('an ordinary retry success does not redirect with an error', async () => {
    sim.nextRows = [{ id: 'apr_y', projectId: 'prj_x', workspaceId: sim.ctx.workspace.id }]
    retryResumeImpl = async () => ({})
    await actions.retryWorkItem('apr_y')
    assert.deepEqual(redirects, [])
  })
})
