'use client'

import { useState } from 'react'

interface TestEvidenceSinkProps {
  projectId: string
}

export function TestEvidenceSink({ projectId }: TestEvidenceSinkProps) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  async function handleTest() {
    setTesting(true)
    setResult(null)

    try {
      const response = await fetch(`/api/v1/projects/${projectId}/test-evidence-sink`, {
        method: 'POST',
      })

      const data = await response.json()
      setResult({
        ok: data.ok ?? false,
        message: data.message ?? 'Unknown error',
      })
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to test evidence sink',
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleTest}
        disabled={testing}
        className="h-10 rounded-md border border-zinc-200 px-3 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        {testing ? 'Testing...' : 'Test Evidence Sink'}
      </button>
      {result && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            result.ok
              ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200'
              : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200'
          }`}
        >
          {result.message}
        </div>
      )}
    </div>
  )
}
