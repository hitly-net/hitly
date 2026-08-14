import { eq } from 'drizzle-orm'
import { memberships, projectMemberships, users } from '@hitly/db/schema'
import { PROJECT_ROLES } from '@hitly/core'
import { addProjectMember, removeProjectMember, updateProjectMemberRole } from '@/actions/projects'
import { AppShell } from '@/components/app-shell'
import { ProjectTabs } from '@/components/project-tabs'
import { canAdminProject } from '@/lib/rbac'
import { requireVisibleProject } from '@/lib/project-page'
import { requireDb } from '@/lib/require-db'
import { redirect } from 'next/navigation'

export const metadata = { title: 'People' }

export default async function ProjectPeoplePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { project, access, workspace } = await requireVisibleProject(id)
  if (!canAdminProject(access)) redirect(`/projects/${id}`)

  const database = requireDb()
  const people = await database
    .select({
      id: projectMemberships.id,
      role: projectMemberships.role,
      userId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(projectMemberships)
    .innerJoin(users, eq(projectMemberships.userId, users.id))
    .where(eq(projectMemberships.projectId, id))

  const workspaceMembers = await database
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, workspace.id))

  const onProject = new Set(people.map((person) => person.userId))
  const candidates = workspaceMembers.filter((member) => !onProject.has(member.userId))

  return (
    <AppShell project={{ id: project.id, name: project.name }}>
      <h1 className="text-2xl font-semibold">{project.name}</h1>
      <ProjectTabs projectId={id} current="People" />

      <form action={addProjectMember.bind(null, id)} className="mt-6 flex max-w-xl gap-2">
        <select
          name="userId"
          className="h-10 flex-1 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          required
        >
          <option value="">Add workspace member…</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name} ({member.email})
            </option>
          ))}
        </select>
        <select
          name="role"
          defaultValue="user"
          className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {PROJECT_ROLES.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded-md bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add
        </button>
      </form>
      <p className="mt-2 text-xs text-zinc-500">Notices still go to the default assignee on Config until team routing ships.</p>

      <ul className="mt-6 max-w-xl divide-y divide-zinc-200 dark:divide-zinc-800">
        {people.map((person) => (
          <li key={person.id} className="flex items-center gap-2 py-3 text-sm">
            <div className="flex-1">
              <p className="font-medium">{person.name}</p>
              <p className="text-xs text-zinc-500">{person.email}</p>
            </div>
            <form action={updateProjectMemberRole.bind(null, id, person.id)} className="flex gap-1">
              <select
                name="role"
                defaultValue={person.role}
                className="h-8 rounded-md border border-zinc-200 px-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              >
                {PROJECT_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
              <button type="submit" className="text-xs underline">
                Save
              </button>
            </form>
            <form action={removeProjectMember.bind(null, id, person.id)}>
              <button type="submit" className="text-xs text-zinc-500 hover:text-red-600">
                Remove
              </button>
            </form>
          </li>
        ))}
      </ul>
    </AppShell>
  )
}
