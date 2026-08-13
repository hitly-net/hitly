import { AppShell } from '@/components/app-shell'

export const metadata = { title: 'Audit' }

export default function AuditPage() {
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Audit</h1>
      <p className="mt-2 text-sm text-zinc-500">Decision records for this workspace.</p>
    </AppShell>
  )
}
