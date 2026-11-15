import { AppShell } from '@/components/app-shell'
import { DeleteAccountForm } from '@/components/delete-account-form'
import { requireSessionUser } from '@/lib/context'
import { loadDeletionPreview } from '@/lib/account-deletion-route'
import { listPasskeysForUser } from '@/lib/passkey-route'

export const metadata = { title: 'Account' }

/**
 * The account page and its danger zone.
 *
 * The preview (which workspaces go with the account, which survive, what
 * blocks the deletion) is rendered from the SAME planner the delete endpoint
 * re-runs server-side, so what the page shows and what actually happens cannot
 * drift apart. The confirmation itself — export first, re-auth, typed DELETE —
 * lives in components/delete-account-form.tsx.
 */
export default async function AccountPage() {
  const user = await requireSessionUser()
  const preview = await loadDeletionPreview(user.id)
  const passkeys = await listPasskeysForUser(user.id)
  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Account</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {user.email}
      </p>
      <h2 className="mt-10 text-lg font-semibold text-red-700 dark:text-red-400">Delete account</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Deletion is immediate and permanent — there is no grace period and nothing can be restored.
      </p>
      <div className="mt-4">
        <DeleteAccountForm preview={preview} hasPasskey={passkeys.length > 0} />
      </div>
    </AppShell>
  )
}
