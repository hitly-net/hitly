'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { isWorkspaceRole } from '@hitly/core'
import { memberships } from '@hitly/db/schema'
import { getAppContext } from '@/lib/context'
import {
  assertWorkspaceKeepsOwner,
  assertWorkspaceMemberRemovalKeepsProjectAdmins,
} from '@/lib/member-guard'
import { newId } from '@/lib/ids'
import { canManageWorkspace } from '@/lib/rbac'
import { requireDb } from '@/lib/require-db'
import { withTenant } from '@/lib/tenant'
import { sendMail } from '@/lib/mail'
import { createAndSendWorkspaceInvite, resendWorkspaceInvite, revokeWorkspaceInvite } from '@/lib/invites'
import { findUserByEmail } from '@/lib/workspace'

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

async function sendAddedToWorkspaceMail(args: { to: string; workspaceName: string }) {
  await sendMail({
    to: args.to,
    subject: `You've been added to ${args.workspaceName} on HITLy`,
    text: `You've been added to ${args.workspaceName}.\n\n${APP_URL}\n`,
  })
}

export async function inviteToWorkspace(formData: FormData) {
  const { user, workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can invite people')
  }
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const invitedRole = String(formData.get('role') ?? 'member')
  if (!email) throw new Error('Email is required')
  if (!isWorkspaceRole(invitedRole) || invitedRole === 'owner') {
    throw new Error('Invalid role')
  }

  const database = requireDb()
  const existingUser = await findUserByEmail(email)
  if (existingUser) {
    const existing = await database
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspace.id), eq(memberships.userId, existingUser.id)))
      .limit(1)
    if (existing.length > 0) throw new Error('That person is already a member')
    await database.insert(memberships).values({
      id: newId('mem').slice(0, 36),
      workspaceId: workspace.id,
      userId: existingUser.id,
      role: invitedRole,
    })
    await sendAddedToWorkspaceMail({ to: email, workspaceName: workspace.name })
  } else {
    // Emails a one-time accept link (lib/invites.ts); inviting the same
    // address again replaces the earlier link.
    await createAndSendWorkspaceInvite({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      email,
      role: invitedRole,
      invitedByUserId: user.id,
      appUrl: APP_URL,
      database,
    })
  }
  revalidatePath('/settings/team')
}

export async function removeWorkspaceMember(memberId: string) {
  const { workspace, role, user } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can remove members')
  }
  // Guards and the delete share one transaction, so a concurrent project
  // role change cannot slip between the count and the removal.
  await withTenant(workspace.id, async () => {
    const database = requireDb()
    const rows = await database.select().from(memberships).where(eq(memberships.id, memberId)).limit(1)
    const member = rows[0]
    if (!member || member.workspaceId !== workspace.id) throw new Error('Member not found')
    if (member.userId === user.id) throw new Error('You cannot remove yourself')
    if (member.role === 'owner') throw new Error('Cannot remove the owner')
    // Server-side backstop for the same rule (a workspace always keeps an
    // owner), independent of the UI hiding the button.
    await assertWorkspaceKeepsOwner({ membershipId: member.id, database })
    // A workspace removal strands the person's project admin seats: refuse
    // while they are the only admin of any project in this workspace.
    await assertWorkspaceMemberRemovalKeepsProjectAdmins({ userId: member.userId, database })
    await database.delete(memberships).where(eq(memberships.id, memberId))
  })
  revalidatePath('/settings/team')
}

export async function cancelInvite(inviteId: string) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can cancel invites')
  }
  // Deleting the invite revokes its link.
  const removed = await revokeWorkspaceInvite({ workspaceId: workspace.id, inviteId, database: requireDb() })
  if (!removed) throw new Error('Invite not found')
  revalidatePath('/settings/team')
}

/** Emails a fresh accept link for a pending invite; any earlier link stops working. */
export async function resendInvite(inviteId: string) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can resend invites')
  }
  const result = await resendWorkspaceInvite({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    inviteId,
    appUrl: APP_URL,
    database: requireDb(),
  })
  if (!result.ok) throw new Error('Invite not found')
  revalidatePath('/settings/team')
}
