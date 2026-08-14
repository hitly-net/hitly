import { CHANNEL_TYPES, DECISIONS, PLUGIN_IDS, PROJECT_ROLES, WORKSPACE_ROLES } from '@hitly/core'
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

const id = (name = 'id') => varchar(name, { length: 36 })

export const users = mysqlTable('users', {
  id: id().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
})

export const sessions = mysqlTable(
  'sessions',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
)

export const accounts = mysqlTable(
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
    accessTokenExpiresAt: timestamp('access_token_expires_at', { fsp: 3 }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { fsp: 3 }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('accounts_user_id_idx').on(table.userId)],
)

export const verifications = mysqlTable('verifications', {
  id: id().primaryKey(),
  identifier: varchar('identifier', { length: 255 }).notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
})

export const workspaces = mysqlTable('workspaces', {
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
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
})

export const memberships = mysqlTable(
  'memberships',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', WORKSPACE_ROLES).notNull().default('member'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('memberships_workspace_user_idx').on(table.workspaceId, table.userId)],
)

export const invites = mysqlTable(
  'invites',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: varchar('email', { length: 255 }).notNull(),
    role: mysqlEnum('role', WORKSPACE_ROLES).notNull().default('member'),
    invitedByUserId: id('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    acceptedAt: timestamp('accepted_at', { fsp: 3 }),
    expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index('invites_workspace_idx').on(table.workspaceId),
    index('invites_email_idx').on(table.email),
  ],
)

export const projects = mysqlTable(
  'projects',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    plugin: mysqlEnum('plugin', PLUGIN_IDS).notNull(),
    credentials: json('credentials').$type<Record<string, unknown>>().notNull(),
    defaultAssigneeUserId: id('default_assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    defaultSlaMinutes: varchar('default_sla_minutes', { length: 16 }).notNull().default('60'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('projects_workspace_idx').on(table.workspaceId)],
)

export const projectMemberships = mysqlTable(
  'project_memberships',
  {
    id: id().primaryKey(),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: mysqlEnum('role', PROJECT_ROLES).notNull().default('user'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('project_memberships_project_user_idx').on(table.projectId, table.userId)],
)

export const projectApiKeys = mysqlTable(
  'project_api_keys',
  {
    id: id().primaryKey(),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    hashedKey: varchar('hashed_key', { length: 255 }).notNull().unique(),
    prefix: varchar('prefix', { length: 32 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index('project_api_keys_project_idx').on(table.projectId)],
)

export const projectRules = mysqlTable(
  'project_rules',
  {
    id: id().primaryKey(),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    priority: int('priority').notNull().default(100),
    match: json('match').$type<Record<string, unknown>>().notNull(),
    actions: json('actions').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('project_rules_project_idx').on(table.projectId)],
)

export const projectChannels = mysqlTable(
  'project_channels',
  {
    id: id().primaryKey(),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', CHANNEL_TYPES).notNull(),
    config: json('config').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('project_channels_project_idx').on(table.projectId)],
)

export const projectEvents = mysqlTable(
  'project_events',
  {
    id: id().primaryKey(),
    projectId: id('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    approvalId: id('approval_id'),
    level: varchar('level', { length: 16 }).notNull().default('info'),
    type: varchar('type', { length: 64 }).notNull(),
    message: text('message').notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index('project_events_project_idx').on(table.projectId),
    index('project_events_approval_idx').on(table.approvalId),
    index('project_events_created_at_idx').on(table.createdAt),
  ],
)

export const approvals = mysqlTable(
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
    plugin: mysqlEnum('plugin', PLUGIN_IDS).notNull(),
    status: mysqlEnum('status', ['pending', 'decided', 'expired', 'failed_resume', 'cancelled'])
      .notNull()
      .default('pending'),
    actionName: varchar('action_name', { length: 255 }).notNull(),
    envelope: json('envelope').$type<Record<string, unknown>>().notNull(),
    origin: json('origin').$type<Record<string, unknown>>().notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    expiresAt: timestamp('expires_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index('approvals_workspace_status_idx').on(table.workspaceId, table.status),
    index('approvals_workspace_status_updated_idx').on(table.workspaceId, table.status, table.updatedAt),
    index('approvals_project_status_idx').on(table.projectId, table.status),
    index('approvals_created_at_idx').on(table.createdAt),
    index('approvals_project_idempotency_idx').on(table.projectId, table.idempotencyKey),
  ],
)

export const userDevices = mysqlTable(
  'user_devices',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expoPushToken: varchar('expo_push_token', { length: 255 }).notNull().unique(),
    platform: mysqlEnum('platform', ['ios', 'android']).notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('user_devices_user_id_idx').on(table.userId)],
)

export const housekeepingJobs = mysqlTable('housekeeping_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  schedule: mysqlEnum('schedule', ['hourly', 'daily', 'weekly']).notNull(),
  lastStartedAt: timestamp('last_started_at', { fsp: 3 }),
  lastFinishedAt: timestamp('last_finished_at', { fsp: 3 }),
  lastError: text('last_error'),
  lastResult: json('last_result').$type<Record<string, unknown>>(),
})

export const decisionRecords = mysqlTable(
  'decision_records',
  {
    id: id().primaryKey(),
    approvalId: id('approval_id')
      .notNull()
      .references(() => approvals.id, { onDelete: 'cascade' }),
    actorUserId: id('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    decision: mysqlEnum('decision', DECISIONS).notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    resumeError: text('resume_error'),
    resumeResponse: json('resume_response').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index('decision_records_approval_idx').on(table.approvalId)],
)
