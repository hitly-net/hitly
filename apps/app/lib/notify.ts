import { and, eq, gte, inArray, or, sql } from 'drizzle-orm'
import {
  AWAITING_HUMAN_APPROVAL_STATUSES,
  isWorkspaceAdmin,
  type ChannelType,
  type WorkspaceRole,
} from '@hitly/core'
import { approvals, memberships, projectChannels, projectMemberships, projects, users } from '@hitly/db/schema'
import { logProjectEvent } from './events'
import { sendMail } from './mail'
import { deletePushTokensByValue, listPushTokens } from './push-tokens'
import { pushCopy, sendExpoPush } from './push'
import { listVisibleProjectIds } from './rbac'
import { requireDb } from './require-db'
import { afterTenantCommit, withTenant } from './tenant'

const APP_URL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'

export async function notifyAssignee(args: {
  workspaceId: string
  projectId: string
  approvalId: string
  assignedUserId: string | null
  actionName: string
  channelTypes: ChannelType[]
  expiresAt?: Date | string | null
}) {
  if (!args.assignedUserId) {
    await logProjectEvent({
      projectId: args.projectId,
      approvalId: args.approvalId,
      level: 'warn',
      type: 'notified',
      message: 'No assignee to notify',
    })
  } else {
    await notifyAssigneeEmail({
      projectId: args.projectId,
      approvalId: args.approvalId,
      assignedUserId: args.assignedUserId,
      actionName: args.actionName,
      channelTypes: args.channelTypes,
    })
  }

  afterTenantCommit(() =>
    notifyPendingItemPush({
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      approvalId: args.approvalId,
      assignedUserId: args.assignedUserId,
      actionName: args.actionName,
      expiresAt: args.expiresAt,
    }),
  )
}

async function notifyAssigneeEmail(args: {
  projectId: string
  approvalId: string
  assignedUserId: string
  actionName: string
  channelTypes: ChannelType[]
}) {
  const database = requireDb()
  const userRows = await database.select().from(users).where(eq(users.id, args.assignedUserId)).limit(1)
  const assignee = userRows[0]
  if (!assignee) return

  const enabled = await database
    .select()
    .from(projectChannels)
    .where(and(eq(projectChannels.projectId, args.projectId), eq(projectChannels.enabled, true)))

  const wanted = new Set(args.channelTypes)
  const channels = enabled.filter((channel) => wanted.has(channel.type))

  for (const channel of channels) {
    if (channel.type !== 'email') {
      await logProjectEvent({
        projectId: args.projectId,
        approvalId: args.approvalId,
        level: 'info',
        type: 'notified',
        message: `${channel.type} channel is not implemented yet`,
        payload: { channelId: channel.id },
      })
      continue
    }
    try {
      const result = await sendMail({
        to: assignee.email,
        subject: `Hitly: ${args.actionName} needs a decision`,
        text: `A work item is waiting for you.\n\n${APP_URL}/inbox/${args.approvalId}\n`,
      })
      await logProjectEvent({
        projectId: args.projectId,
        approvalId: args.approvalId,
        type: 'notified',
        message: result.delivered ? `Emailed ${assignee.email}` : `Email skipped (${result.reason})`,
        payload: { to: assignee.email, delivered: result.delivered },
      })
    } catch (error) {
      await logProjectEvent({
        projectId: args.projectId,
        approvalId: args.approvalId,
        level: 'error',
        type: 'notified',
        message: error instanceof Error ? error.message : 'Email failed',
      })
    }
  }
}

/**
 * Inbox-visible reviewers who can decide, plus the assignee when they can
 * see the project. Readers are skipped unless they are the assignee.
 */
export async function listPendingPushRecipientIds(args: {
  workspaceId: string
  projectId: string
  assignedUserId: string | null
}): Promise<string[]> {
  const database = requireDb()
  const adminRows = await database
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, args.workspaceId), inArray(memberships.role, ['owner', 'admin'])))
  const reviewerRows = await database
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, args.projectId),
        eq(projectMemberships.workspaceId, args.workspaceId),
        inArray(projectMemberships.role, ['admin', 'user']),
      ),
    )
  const ids = new Set<string>([...adminRows.map((row) => row.userId), ...reviewerRows.map((row) => row.userId)])
  if (args.assignedUserId && (await userCanSeeProject(args.assignedUserId, args.workspaceId, args.projectId))) {
    ids.add(args.assignedUserId)
  }
  return [...ids]
}

async function userCanSeeProject(userId: string, workspaceId: string, projectId: string) {
  const database = requireDb()
  const memberRows = await database
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1)
  const membership = memberRows[0]
  if (!membership) return false
  if (isWorkspaceAdmin(membership.role)) return true
  const projectRows = await database
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, userId),
        eq(projectMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1)
  return Boolean(projectRows[0])
}

async function projectNameFor(projectId: string, workspaceId: string) {
  const database = requireDb()
  const rows = await database
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)
  return rows[0]?.name ?? null
}

async function workspaceRoleFor(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const database = requireDb()
  const rows = await database
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .limit(1)
  return rows[0]?.role ?? null
}

/** Same pending count as inbox summary, without the expiry settle (push must stay non-blocking). */
async function pendingBadgeCount(args: { workspaceId: string; userId: string; workspaceRole: WorkspaceRole }) {
  const projectIds = await listVisibleProjectIds(args)
  if (projectIds.length === 0) return 0
  const nowDate = new Date()
  const database = requireDb()
  const pendingRows = await database
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(
      and(
        inArray(approvals.projectId, projectIds),
        eq(approvals.workspaceId, args.workspaceId),
        inArray(approvals.status, [...AWAITING_HUMAN_APPROVAL_STATUSES]),
        or(sql`${approvals.expiresAt} is null`, gte(approvals.expiresAt, nowDate)),
      ),
    )
  return Number(pendingRows[0]?.count ?? 0)
}

export async function notifyPendingItemPush(args: {
  workspaceId: string
  projectId: string
  approvalId: string
  assignedUserId: string | null
  actionName: string
  expiresAt?: Date | string | null
}) {
  return withTenant(args.workspaceId, async () => {
    const recipientIds = await listPendingPushRecipientIds(args)
    if (recipientIds.length === 0) return

    const projectName = await projectNameFor(args.projectId, args.workspaceId)
    const copy = pushCopy({
      actionName: args.actionName,
      projectName,
      expiresAt: args.expiresAt,
    })
    const data = {
      type: 'approval',
      itemId: args.approvalId,
      approvalId: args.approvalId,
      instanceUrl: APP_URL,
    }

    let delivered = 0
    let total = 0
    for (const userId of recipientIds) {
      const devices = await listPushTokens(userId)
      if (devices.length === 0) continue
      const role = await workspaceRoleFor(userId, args.workspaceId)
      if (!role) continue
      const badge = await pendingBadgeCount({
        workspaceId: args.workspaceId,
        userId,
        workspaceRole: role,
      })
      try {
        const result = await sendExpoPush({
          tokens: devices.map((device) => device.token),
          title: copy.title,
          body: copy.body,
          badge,
          data,
        })
        total += result.tickets.length
        delivered += result.tickets.filter((ticket) => ticket.delivered).length
        if (result.staleTokens.length > 0) {
          await deletePushTokensByValue(result.staleTokens)
        }
      } catch (error) {
        await logProjectEvent({
          projectId: args.projectId,
          approvalId: args.approvalId,
          level: 'error',
          type: 'notified',
          message: error instanceof Error ? error.message : 'Push failed',
          payload: { channel: 'push' },
        })
      }
    }

    if (total > 0) {
      await logProjectEvent({
        projectId: args.projectId,
        approvalId: args.approvalId,
        type: 'notified',
        message: `Pushed ${delivered}/${total} device(s)`,
        payload: { channel: 'push', delivered, total },
      })
    }
  })
}
