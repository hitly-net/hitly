'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { isWorkspaceRole } from '@hitly/core'
import { invites, memberships } from '@hitly/db/schema'
import { getAppContext } from '@/lib/context'
import { newId } from '@/lib/ids'
import { canManageWorkspace } from '@/lib/rbac'
import { requireDb } from '@/lib/require-db'
import { sendMail } from '@/lib/mail'
import { findUserByEmail } from '@/lib/workspace'

const APP_URL = process.env.BETTER_AUTH_URL ?? 'http://localhost:3001'

async function sendWorkspaceInviteMail(args: {
  to: string
  workspaceName: string
  existingMember: boolean
}) {
  if (args.existingMember) {
    await sendMail({
      to: args.to,
      subject: `You've been added to ${args.workspaceName} on Hitly`,
      text: `You've been added to ${args.workspaceName}.\n\n${APP_URL}\n`,
    })
    return
  }
  await sendMail({
    to: args.to,
    subject: `You're invited to ${args.workspaceName} on Hitly`,
    text: `You've been invited to join ${args.workspaceName}.\n\nCreate an account: ${APP_URL}/signup\n\nThis invite expires in 14 days.\n`,
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
    await sendWorkspaceInviteMail({
      to: email,
      workspaceName: workspace.name,
      existingMember: true,
    })
  } else {
    await database.insert(invites).values({
      id: newId('inv').slice(0, 36),
      workspaceId: workspace.id,
      email,
      role: invitedRole,
      invitedByUserId: user.id,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    })
    await sendWorkspaceInviteMail({
      to: email,
      workspaceName: workspace.name,
      existingMember: false,
    })
  }
  revalidatePath('/settings/team')
}

export async function removeWorkspaceMember(memberId: string) {
  const { workspace, role, user } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can remove members')
  }
  const database = requireDb()
  const rows = await database.select().from(memberships).where(eq(memberships.id, memberId)).limit(1)
  const member = rows[0]
  if (!member || member.workspaceId !== workspace.id) throw new Error('Member not found')
  if (member.userId === user.id) throw new Error('You cannot remove yourself')
  if (member.role === 'owner') throw new Error('Cannot remove the owner')
  await database.delete(memberships).where(eq(memberships.id, memberId))
  revalidatePath('/settings/team')
}

export async function cancelInvite(inviteId: string) {
  const { workspace, role } = await getAppContext()
  if (!canManageWorkspace(role)) {
    throw new Error('Only workspace admins can cancel invites')
  }
  const database = requireDb()
  const rows = await database.select().from(invites).where(eq(invites.id, inviteId)).limit(1)
  const invite = rows[0]
  if (!invite || invite.workspaceId !== workspace.id) throw new Error('Invite not found')
  await database.delete(invites).where(eq(invites.id, inviteId))
  revalidatePath('/settings/team')
}
