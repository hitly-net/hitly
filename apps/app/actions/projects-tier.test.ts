/**
 * Action-path tests for the project/retention caps:
 *  - createProject over the live-project cap returns the typed refusal and
 *    commits no project rows (writer throws out of the tenant transaction);
 *  - resume/unarchive over the cap surfaces the refusal message through the
 *    lifecycle result;
 *  - retryResume's tier refusal rides the ?error= redirect so the reviewer
 *    sees the human message (never a 500).
 */
import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { fakeDb, sim } from '../lib/gate-action-test-harness'
import { TIER_LIMIT_CODE, TierLimitError } from '../lib/tier-enforcement'

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

const projectRefusal = {
  code: TIER_LIMIT_CODE,
  limitKey: 'live_projects' as const,
  message: 'Live project limit reached (2 of 2 projects live at once). Pause or archive a project, or upgrade to run more.',
  limit: 2,
  usage: 2,
}
const retentionRefusal = {
  code: TIER_LIMIT_CODE,
  limitKey: 'completed_retention_days' as const,
  message: "This item is 12 days old — past your plan's 10-day retention for completed items. Upgrade to extend retention.",
  limit: 10,
  usage: 12,
}

let setProjectStatusImpl: (args: { status: string }) => Promise<{ ok: boolean; status?: string; error?: string; code?: string; status2?: number }>
let retryResumeImpl: () => Promise<{ error?: string; code?: string; status?: number }>

mock.module(new URL('../lib/project-create.ts', import.meta.url).href, {
  namedExports: {
    assertCreatorVerified: async () => undefined,
    // WRITE FIRST, gate SECOND (mutant ordering): only the throw path passes.
    insertNewProject: async (args: { name: unknown }) => {
      sim.record(`project:${String(args.name)}`, () => {
        sim.projects.push({ id: `prj_${sim.seq++}`, name: String(args.name), by: sim.ctx.user.id })
      })
      throw new TierLimitError(projectRefusal)
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
    setProjectStatus: async (args: { status: string }) => setProjectStatusImpl(args),
  },
})
mock.module(new URL('../lib/approvals.ts', import.meta.url).href, {
  namedExports: {
    retryResume: async () => retryResumeImpl(),
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
  redirects.length = 0
  setProjectStatusImpl = async () => ({ ok: true, status: 'live' })
  retryResumeImpl = async () => ({})
})

function projectForm(name = 'Te Project'): FormData {
  const data = new FormData()
  data.set('name', name)
  data.set('description', '')
  data.set('plugin', 'mastra')
  return data
}

describe('createProject live-project cap', () => {
  it('over the cap returns the typed refusal and commits no project rows', async () => {
    const result = await actions.createProject(projectForm())
    assert.deepEqual(result, {
      status: 'error',
      code: TIER_LIMIT_CODE,
      limitKey: 'live_projects',
      message: projectRefusal.message,
    })
    assert.equal(sim.committed.length, 0, `nothing may commit: ${sim.committed.join(',')}`)
    assert.equal(sim.projects.length, 0)
  })
})

describe('resume/unarchive live-project cap', () => {
  it('returns the refusal message through the lifecycle result', async () => {
    setProjectStatusImpl = async () => ({ ok: false, error: projectRefusal.message, code: TIER_LIMIT_CODE })
    const result = await actions.resumeProject('prj_x')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, projectRefusal.message)
  })

  it('a successful resume still reports ok', async () => {
    const result = await actions.unarchiveProject('prj_x')
    assert.equal(result.ok, true)
  })
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
