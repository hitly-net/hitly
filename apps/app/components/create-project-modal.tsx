'use client'

import { useRef } from 'react'
import { PLUGIN_IDS } from '@hitly/core'
import { PLUGIN_BRANDS } from '@hitly/ui'
import { createProject } from '@/actions/projects'

export function CreateProjectModal() {
  const dialogRef = useRef<HTMLDialogElement>(null)

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="h-10 shrink-0 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
      >
        New project
      </button>
      <dialog
        ref={dialogRef}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-lg backdrop:bg-zinc-950/40 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <h2 className="text-lg font-semibold">Create project</h2>
        <p className="mt-1 text-sm text-zinc-500">A project maps to one origin and collects its work items.</p>
        <form action={createProject} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-500">Name</span>
            <input
              name="name"
              required
              autoFocus
              placeholder="Refunds"
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-500">Description</span>
            <textarea
              name="description"
              placeholder="Optional"
              className="min-h-20 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm text-zinc-500">Plugin</span>
            <select
              name="plugin"
              defaultValue="mastra"
              className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {PLUGIN_IDS.map((plugin) => (
                <option key={plugin} value={plugin}>
                  {PLUGIN_BRANDS[plugin].label}
                  {plugin === 'http' ? ' — n8n, webhooks, custom callbacks' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="h-10 rounded-md border border-zinc-200 px-4 text-sm dark:border-zinc-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="h-10 rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              Create
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
