import Link from 'next/link'
import { AppShell } from '@/components/app-shell'

export default function HomePage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Inbox summary</h1>
      <p className="mt-2 text-sm text-zinc-500">Approvals waiting for a human, plus connection health.</p>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500">Needs attention</p>
          <p className="mt-2 text-3xl font-semibold">0</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500">Decided today</p>
          <p className="mt-2 text-3xl font-semibold">0</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-sm text-zinc-500">Connections</p>
          <p className="mt-2 text-3xl font-semibold">0</p>
        </div>
      </div>
      <Link href="/inbox" className="mt-6 inline-block text-sm font-medium underline">
        Open inbox
      </Link>
    </AppShell>
  )
}
