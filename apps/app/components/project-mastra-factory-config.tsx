'use client'

import { useActionState } from 'react'
import { saveMastraFactoryConfigAction, type ProjectConfigSaveState } from '@/actions/projects'

interface ProjectMastraFactoryConfigProps {
  projectId: string
  gates: { plan: boolean; review: boolean; ask_user: boolean }
  mergeAfterAccept: boolean
  readOnly?: boolean
}

/**
 * Gate truth for @hitly/mastra-factory-plugin. The Factory host polls the
 * key-scoped config endpoint for these values; unchecking a gate stops new
 * requests of that kind (in-flight approvals keep their decision path).
 * Merge-after-accept is inert unless the Factory host also has a GitHub token
 * configured — both switches must be on.
 */
export function ProjectMastraFactoryConfig({ projectId, gates, mergeAfterAccept, readOnly }: ProjectMastraFactoryConfigProps) {
  const initialState: ProjectConfigSaveState = { status: 'idle' }
  const [state, formAction, pending] = useActionState(
    saveMastraFactoryConfigAction.bind(null, projectId),
    initialState,
  )

  return (
    <form action={formAction} className="mt-3 flex max-w-xl flex-col gap-3">
      <p className="text-sm text-zinc-500">
        Which Mastra Factory checkpoints open a HITLy request. Disabling a gate lets that checkpoint run
        unattended; existing open requests keep their decision path.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="hidden" name="gatePlan" value="false" />
        <input type="checkbox" name="gatePlan" defaultChecked={gates.plan} disabled={readOnly} className="h-4 w-4" />
        Plan gate — hold <code>submit_plan</code> for human acceptance
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="hidden" name="gateReview" value="false" />
        <input type="checkbox" name="gateReview" defaultChecked={gates.review} disabled={readOnly} className="h-4 w-4" />
        Review gate — hold <code>factory_record_review_verdict</code> for human acceptance
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="hidden" name="gateAskUser" value="false" />
        <input type="checkbox" name="gateAskUser" defaultChecked={gates.ask_user} disabled={readOnly} className="h-4 w-4" />
        Ask-user gate — surface the agent&apos;s <code>ask_user</code> question in HITLy
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="hidden" name="mergeAfterAccept" value="false" />
        <input
          type="checkbox"
          name="mergeAfterAccept"
          defaultChecked={mergeAfterAccept}
          disabled={readOnly}
          className="h-4 w-4"
        />
        Merge on review accept (squash) — also requires a GitHub token on the Factory host; until both are on,
        accepted reviews are only marked merge-ready
      </label>
      {!readOnly && (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {pending ? 'Saving...' : 'Save gates'}
          </button>
          {state.status === 'saved' && <span className="text-xs text-green-600">Saved</span>}
          {state.status === 'error' && <span className="text-xs text-red-600">{state.error}</span>}
        </div>
      )}
    </form>
  )
}
