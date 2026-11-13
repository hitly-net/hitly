import { and, eq, isNull, sql } from 'drizzle-orm'
import { invites, memberships, users } from '@hitly/db/schema'
import { cancelInvite, removeWorkspaceMember } from '@/actions/team'
import { AppShell } from '@/components/app-shell'
import { ResendInviteButton, WorkspaceInviteForm } from '@/components/team-invite-controls'
import { getAppContext } from '@/lib/context'
import { canManageWorkspace } from '@/lib/rbac'
import { requireDb } from '@/lib/require-db'

export const metadata = { title: 'Team' }

export default async function TeamPage() {
  const { workspace, role, user } = await getAppContext()
  const database = requireDb()
  const members = await database
    .select({
      id: memberships.id,
      role: memberships.role,
      userId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, workspace.id))
  
  const pendingInvites = await database
    .select({
      id: invites.id,
      email: invites.email,
      role: invites.role,
      expiresAt: invites.expiresAt,
      expired: sql<boolean>`${invites.expiresAt} <= now()`,
    })
    .from(invites)
    .where(
      and(
        eq(invites.workspaceId, workspace.id),
        // Expired invites stay listed so they can be resent.
        isNull(invites.acceptedAt)
      )
    )
  
  const admin = canManageWorkspace(role)

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Team</h1>
      <p className="mt-2 text-sm text-zinc-500">Workspace members. Project roles are set on each project.</p>
      {admin ? <WorkspaceInviteForm /> : null}
      <ul className="mt-6 max-w-md divide-y divide-zinc-200 dark:divide-zinc-800">
        {members.map((member) => (
          <li key={member.id} className="flex items-center justify-between py-3 text-sm">
            <div>
              <p className="font-medium">{member.name}</p>
              <p className="text-xs text-zinc-500">
                {member.email} · {member.role}
              </p>
            </div>
            {admin && member.userId !== user.id && member.role !== 'owner' ? (
              <form action={removeWorkspaceMember.bind(null, member.id)}>
                <button type="submit" className="text-xs text-zinc-500 hover:text-red-600">
                  Remove
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {admin && pendingInvites.length > 0 ? (
        <>
          <h2 className="mt-8 text-lg font-semibold">Pending invites</h2>
          <p className="mt-2 text-sm text-zinc-500">
            These people have been invited but haven&apos;t accepted yet. Resend emails a fresh link and
            the old one stops working.
          </p>
          <ul className="mt-4 max-w-md divide-y divide-zinc-200 dark:divide-zinc-800">
            {pendingInvites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <p className="font-medium">{invite.email}</p>
                  <p className="text-xs text-zinc-500">
                    {invite.role} ·{' '}
                    {invite.expired
                      ? 'expired'
                      : `expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex gap-3">
                  <ResendInviteButton inviteId={invite.id} />
                  <form action={cancelInvite.bind(null, invite.id)}>
                    <button type="submit" className="text-xs text-zinc-500 hover:text-red-600">
                      Cancel
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </AppShell>
  )
}
