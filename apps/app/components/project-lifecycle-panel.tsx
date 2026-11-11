'use client'

import { useRef, useState, useTransition } from 'react'
import type { ProjectStatus } from '@hitly/core'
import {
  archiveProject,
  deleteProject,
  pauseProject,
  resumeProject,
  unarchiveProject,
} from '@/actions/projects'

const fieldClass =
  'h-10 w-full rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900'
const secondaryBtn =
  'h-10 rounded-md border border-zinc-200 px-4 text-sm dark:border-zinc-700'
const primaryBtn =
  'h-10 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900'
const dangerBtn =
  'h-10 rounded-md bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-60 dark:bg-red-600'

export function ProjectLifecyclePanel({
  projectId,
  projectName,
  status,
  lifecycleAvailable,
}: {
  projectId: string
  projectName: string
  status: ProjectStatus | string
  lifecycleAvailable: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const deleteDialog = useRef<HTMLDialogElement>(null)

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) setError(result.error)
    })
  }

  return (
    <section className="mt-10 max-w-xl">
      <h2 className="text-lg font-semibold">Project status</h2>
      <p className="mt-1 text-sm text-zinc-500">
        {lifecycleAvailable
          ? 'Pause refuses new requests. Archive hides the project and makes it read-only. Delete is allowed only after archive.'
          : 'Type the project name to permanently delete it and its work items.'}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-medium text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {lifecycleAvailable ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {status === 'live' ? (
            <button type="button" disabled={pending} className={secondaryBtn} onClick={() => run(() => pauseProject(projectId))}>
              Pause
            </button>
          ) : null}
          {status === 'paused' ? (
            <button type="button" disabled={pending} className={primaryBtn} onClick={() => run(() => resumeProject(projectId))}>
              Resume
            </button>
          ) : null}
          {status !== 'archived' ? (
            <button type="button" disabled={pending} className={secondaryBtn} onClick={() => run(() => archiveProject(projectId))}>
              Archive
            </button>
          ) : (
            <button type="button" disabled={pending} className={primaryBtn} onClick={() => run(() => unarchiveProject(projectId))}>
              Unarchive
            </button>
          )}
          {status === 'archived' ? (
            <button type="button" disabled={pending} className={dangerBtn} onClick={() => deleteDialog.current?.showModal()}>
              Delete
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-4">
          <button type="button" disabled={pending} className={dangerBtn} onClick={() => deleteDialog.current?.showModal()}>
            Delete project
          </button>
        </div>
      )}

      <dialog
        ref={deleteDialog}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-lg backdrop:bg-zinc-950/40 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h3 className="text-lg font-semibold">Delete {projectName}?</h3>
        <p className="mt-2 text-sm text-zinc-500">
          This permanently removes the project and its work items. Type the project name to confirm.
        </p>
        <form
          className="mt-4 flex flex-col gap-3"
          action={async (formData) => {
            setError(null)
            const result = await deleteProject(projectId, formData)
            if (result && !result.ok) {
              setError(result.error)
              deleteDialog.current?.close()
            }
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-500">Project name</span>
            <input name="confirmName" required autoFocus placeholder={projectName} className={fieldClass} />
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className={secondaryBtn} onClick={() => deleteDialog.current?.close()}>
              Cancel
            </button>
            <button type="submit" className={dangerBtn}>
              Delete
            </button>
          </div>
        </form>
      </dialog>
    </section>
  )
}
