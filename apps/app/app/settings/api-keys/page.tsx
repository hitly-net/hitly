import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'API keys' }

export default function ApiKeysPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">API keys</h1>
      <p className="mt-2 text-sm text-zinc-500">Ingest keys for plugins. Shown once at creation.</p>
      <button type="button" className="mt-6 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
        Create key
      </button>
    </AppShell>
  )
}
