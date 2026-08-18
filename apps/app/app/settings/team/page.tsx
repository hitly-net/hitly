import { and, eq, gt, isNull } from 'drizzle-orm'
import { invites, memberships, users } from '@hitly/db/schema'
import { cancelInvite, inviteToWorkspace, removeWorkspaceMember } from '@/actions/team'
import { AppShell } from '@/components/app-shell'
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
    })
    .from(invites)
    .where(
      and(
        eq(invites.workspaceId, workspace.id),
        isNull(invites.acceptedAt),
        gt(invites.expiresAt, new Date())
      )
    )
  
  const admin = canManageWorkspace(role)

  return (
    <AppShell>
      <h1 className="text-2xl font-semibold">Team</h1>
      <p className="mt-2 text-sm text-zinc-500">Workspace members. Project roles are set on each project.</p>
      {admin ? (
        <form action={inviteToWorkspace} className="mt-6 flex max-w-md gap-2">
          <input
            name="email"
            type="email"
            required
            placeholder="Invite email"
            className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <select
            name="role"
            defaultValue="member"
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Invite
          </button>
        </form>
      ) : null}
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
            These people have been invited but haven&apos;t signed up yet.
          </p>
          <ul className="mt-4 max-w-md divide-y divide-zinc-200 dark:divide-zinc-800">
            {pendingInvites.map((invite) => (
              <li key={invite.id} className="flex items-center justify-between py-3 text-sm">
                <div>
                  <p className="font-medium">{invite.email}</p>
                  <p className="text-xs text-zinc-500">
                    {invite.role} · expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <form action={cancelInvite.bind(null, invite.id)}>
                  <button type="submit" className="text-xs text-zinc-500 hover:text-red-600">
                    Cancel
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </AppShell>
  )
}
