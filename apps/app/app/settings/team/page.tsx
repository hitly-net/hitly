import { eq } from 'drizzle-orm'
import { memberships, users } from '@hitly/db/schema'
import { inviteToWorkspace, removeWorkspaceMember } from '@/actions/team'
import { AppShell } from '@/components/app-shell'
import { getAppContext } from '@/lib/context'
import { canManageWorkspace } from '@/lib/rbac'
import { requireDb } from '@/lib/require-db'

export const metadata = { title: 'Team' }

export default async function TeamPage() {
  const { workspace, role, user } = await getAppContext()
  const members = await requireDb()
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
    </AppShell>
  )
}
