import { and, eq } from 'drizzle-orm'
import { projectChannels, users } from '@hitly/db/schema'
import type { ChannelType } from '@hitly/core'
import { logProjectEvent } from './events'
import { sendMail } from './mail'
import { listUserDeviceTokens } from './devices'
import { getApprovalProjectName } from './approval-detail'
import { pushCopy, sendExpoPush } from './push'
import { requireDb } from './require-db'

const APP_URL = process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'

export async function notifyAssignee(args: {
  projectId: string
  approvalId: string
  assignedUserId: string | null
  actionName: string
  channelTypes: ChannelType[]
}) {
  if (!args.assignedUserId) {
    await logProjectEvent({
      projectId: args.projectId,
      approvalId: args.approvalId,
      level: 'warn',
      type: 'notified',
      message: 'No assignee to notify',
    })
    return
  }

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

  try {
    await notifyAssigneePush({
      projectId: args.projectId,
      approvalId: args.approvalId,
      assignedUserId: args.assignedUserId,
      actionName: args.actionName,
    })
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

async function notifyAssigneePush(args: {
  projectId: string
  approvalId: string
  assignedUserId: string
  actionName: string
}) {
  const devices = await listUserDeviceTokens(args.assignedUserId)
  if (devices.length === 0) return

  const projectName = await getApprovalProjectName(args.projectId)
  const copy = pushCopy({ actionName: args.actionName, projectName })
  try {
    const tickets = await sendExpoPush({
      tokens: devices.map((device) => device.token),
      title: copy.title,
      body: copy.body,
      data: {
        type: 'approval',
        approvalId: args.approvalId,
        instanceUrl: APP_URL,
      },
    })
    const delivered = tickets.filter((ticket) => ticket.delivered).length
    await logProjectEvent({
      projectId: args.projectId,
      approvalId: args.approvalId,
      type: 'notified',
      message: `Pushed ${delivered}/${tickets.length} device(s)`,
      payload: { channel: 'push', delivered, total: tickets.length },
    })
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
