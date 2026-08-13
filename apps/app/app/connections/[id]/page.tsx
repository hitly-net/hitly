import Link from 'next/link'
import { AppShell } from '@/components/app-shell'

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000'

export default async function ConnectionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Connection {id}</h1>
      <p className="mt-2 text-sm text-zinc-500">Last ingest and resume errors will show here.</p>
      <Link href={`${WEB_URL}/integrations/mastra`} className="mt-4 inline-block text-sm underline">
        Open guide
      </Link>
    </AppShell>
  )
}
