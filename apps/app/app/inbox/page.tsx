import Link from 'next/link'
import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Inbox' }

export default function InboxPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Inbox</h1>
      <p className="mt-2 text-sm text-zinc-500">Pending, decided, and expired approvals.</p>
      <div className="mt-8 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500">
        No approvals yet. Wire Mastra with{' '}
        <Link href={`${process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'}/integrations/mastra`} className="underline">
          the integration guide
        </Link>
        .
      </div>
    </AppShell>
  )
}
