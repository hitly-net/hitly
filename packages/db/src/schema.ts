import { CHANNEL_TYPES, DECISIONS, PLUGIN_IDS, PROJECT_ROLES, WORKSPACE_ROLES } from '@hitly/core'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'

const id = (name = 'id') => varchar(name, { length: 36 })

const createdAt = () => timestamp('created_at', { precision: 3, withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const workspaceRoleEnum = pgEnum('workspace_role', WORKSPACE_ROLES)
export const projectRoleEnum = pgEnum('project_role', PROJECT_ROLES)
export const pluginIdEnum = pgEnum('plugin_id', PLUGIN_IDS)
export const channelTypeEnum = pgEnum('channel_type', CHANNEL_TYPES)
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'decided',
  'expired',
  'failed_resume',
  'cancelled',
])
export const decisionEnum = pgEnum('decision', DECISIONS)
export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android'])
export const housekeepingScheduleEnum = pgEnum('housekeeping_schedule', ['hourly', 'daily', 'weekly'])

export const users = pgTable('users', {
  id: id().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const sessions = pgTable(
  'sessions',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
)

export const accounts = pgTable(
  'accounts',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { precision: 3, withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { precision: 3, withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)],
)

export const verifications = pgTable('verifications', {
  id: id().primaryKey(),
  identifier: varchar('identifier', { length: 255 }).notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const workspaces = pgTable('workspaces', {
  id: id().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  defaultSlaMinutes: varchar('default_sla_minutes', { length: 16 }).notNull().default('60'),
  /**
   * Cloud-only until moved to a private billing table. The OSS server ignores these columns.
   */
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  /** OSS default is self-hosted (unlimited). Cloud maps Stripe plans onto this field. */
  plan: varchar('plan', { length: 64 }).notNull().default('self-hosted'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const memberships = pgTable(
  'memberships',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: workspaceRoleEnum('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('memberships_workspace_user_idx').on(table.workspaceId, table.userId)],
)

export const invites = pgTable(
  'invites',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: workspaceRoleEnum('role').notNull().default('member'),
    invitedByUserId: id('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { precision: 3, withTimezone: true }),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('invites_workspace_idx').on(table.workspaceId), index('invites_email_idx').on(table.email)],
)

export const projects = pgTable(
  'projects',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    plugin: pluginIdEnum('plugin').notNull(),
    credentials: jsonb('credentials').$type<Record<string, unknown>>().notNull(),
    defaultAssigneeUserId: id('default_assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    defaultSlaMinutes: varchar('default_sla_minutes', { length: 16 }).notNull().default('60'),
    evidenceSinkType: varchar('evidence_sink_type', { length: 16 }).notNull().default('none'),
    evidenceSinkConfig: jsonb('evidence_sink_config').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('projects_workspace_idx').on(table.workspaceId)],
)

export const projectMemberships = pgTable(
  'project_memberships',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull().default('user'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('project_memberships_project_user_idx').on(table.projectId, table.userId),
    index('project_memberships_workspace_idx').on(table.workspaceId),
  ],
)

export const projectApiKeys = pgTable(
  'project_api_keys',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    hashedKey: varchar('hashed_key', { length: 255 }).notNull().unique(),
    prefix: varchar('prefix', { length: 32 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { precision: 3, withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index('project_api_keys_project_idx').on(table.projectId),
    index('project_api_keys_workspace_idx').on(table.workspaceId),
  ],
)

export const projectRules = pgTable(
  'project_rules',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    priority: integer('priority').notNull().default(100),
    match: jsonb('match').$type<Record<string, unknown>>().notNull(),
    actions: jsonb('actions').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('project_rules_project_idx').on(table.projectId),
    index('project_rules_workspace_idx').on(table.workspaceId),
  ],
)

export const projectChannels = pgTable(
  'project_channels',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: channelTypeEnum('type').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('project_channels_project_idx').on(table.projectId),
    index('project_channels_workspace_idx').on(table.workspaceId),
  ],
)

export const projectEvents = pgTable(
  'project_events',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    approvalId: id('approval_id'),
    level: varchar('level', { length: 16 }).notNull().default('info'),
    type: varchar('type', { length: 64 }).notNull(),
    message: text('message').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('project_events_project_idx').on(table.projectId),
    index('project_events_approval_idx').on(table.approvalId),
    index('project_events_created_at_idx').on(table.createdAt),
    index('project_events_workspace_idx').on(table.workspaceId),
  ],
)

export const approvals = pgTable(
  'approvals',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    assignedUserId: id('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    plugin: pluginIdEnum('plugin').notNull(),
    status: approvalStatusEnum('status').notNull().default('pending'),
    actionName: varchar('action_name', { length: 255 }).notNull(),
    envelope: jsonb('envelope').$type<Record<string, unknown>>().notNull(),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('approvals_workspace_status_idx').on(table.workspaceId, table.status),
    index('approvals_workspace_status_updated_idx').on(table.workspaceId, table.status, table.updatedAt),
    index('approvals_project_status_idx').on(table.projectId, table.status),
    index('approvals_created_at_idx').on(table.createdAt),
    index('approvals_project_idempotency_idx').on(table.projectId, table.idempotencyKey),
  ],
)

export const userDevices = pgTable(
  'user_devices',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expoPushToken: varchar('expo_push_token', { length: 255 }).notNull().unique(),
    platform: devicePlatformEnum('platform').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('user_devices_user_id_idx').on(table.userId)],
)

export const housekeepingJobs = pgTable('housekeeping_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  schedule: housekeepingScheduleEnum('schedule').notNull(),
  lastStartedAt: timestamp('last_started_at', { precision: 3, withTimezone: true }),
  lastFinishedAt: timestamp('last_finished_at', { precision: 3, withTimezone: true }),
  lastError: text('last_error'),
  lastResult: jsonb('last_result').$type<Record<string, unknown>>(),
})

export const decisionRecords = pgTable(
  'decision_records',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    approvalId: id('approval_id')
      .notNull()
      .references(() => approvals.id, { onDelete: 'cascade' }),
    actorUserId: id('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    decision: decisionEnum('decision').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    resumeError: text('resume_error'),
    resumeResponse: jsonb('resume_response').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index('decision_records_approval_idx').on(table.approvalId),
    index('decision_records_workspace_idx').on(table.workspaceId),
  ],
)

export const evidenceReceipts = pgTable(
  'evidence_receipts',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    approvalId: id('approval_id')
      .notNull()
      .references(() => approvals.id, { onDelete: 'cascade' }),
    eventId: varchar('event_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 32 }).notNull(),
    seq: integer('seq').notNull(),
    contentSha256: varchar('content_sha256', { length: 64 }).notNull(),
    storeUri: text('store_uri').notNull(),
    storedAt: timestamp('stored_at', { precision: 3, withTimezone: true }).notNull(),
    evidenceDurable: boolean('evidence_durable').notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [
    index('evidence_receipts_approval_idx').on(table.approvalId),
    index('evidence_receipts_event_id_idx').on(table.eventId),
    index('evidence_receipts_workspace_idx').on(table.workspaceId),
  ],
)

/** Tables Cloud RLS pins to `app.workspace_id`. Control-plane identity tables are not listed. */
export const TENANT_TABLES = [
  'projects',
  'project_memberships',
  'project_api_keys',
  'project_rules',
  'project_channels',
  'project_events',
  'approvals',
  'decision_records',
  'evidence_receipts',
] as const
