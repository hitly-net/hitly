import { PLUGIN_IDS, DECISIONS } from '@hitly/core'
import {
  boolean,
  index,
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
    role: mysqlEnum('role', ['owner', 'admin', 'member']).notNull().default('member'),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('memberships_workspace_user_idx').on(table.workspaceId, table.userId)],
)

export const connections = mysqlTable(
  'connections',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    plugin: mysqlEnum('plugin', PLUGIN_IDS).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    credentials: json('credentials').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index('connections_workspace_idx').on(table.workspaceId)],
)

export const apiKeys = mysqlTable(
  'api_keys',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    hashedKey: varchar('hashed_key', { length: 255 }).notNull().unique(),
    prefix: varchar('prefix', { length: 32 }).notNull(),
    lastUsedAt: timestamp('last_used_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index('api_keys_workspace_idx').on(table.workspaceId)],
)

export const approvals = mysqlTable(
  'approvals',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    connectionId: id('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    plugin: mysqlEnum('plugin', PLUGIN_IDS).notNull(),
    status: mysqlEnum('status', ['pending', 'decided', 'expired', 'failed_resume'])
      .notNull()
      .default('pending'),
    actionName: varchar('action_name', { length: 255 }).notNull(),
    envelope: json('envelope').$type<Record<string, unknown>>().notNull(),
    origin: json('origin').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { fsp: 3 }),
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index('approvals_workspace_status_idx').on(table.workspaceId, table.status),
    index('approvals_created_at_idx').on(table.createdAt),
  ],
)

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
    createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index('decision_records_approval_idx').on(table.approvalId)],
)
