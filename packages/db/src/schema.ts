import { CHANNEL_TYPES, DECISIONS, PLUGIN_IDS, PROJECT_ROLES, PROJECT_STATUSES, WORKSPACE_PLANS, WORKSPACE_ROLES } from '@hitly/core'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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
export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES)
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

/**
 * A signed-in email change that has not been confirmed yet. The live
 * `users.email` is left alone until the token in the new inbox is used;
 * only the SHA-256 of that token is stored here.
 */
export const pendingEmailChanges = pgTable(
  'pending_email_changes',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pendingEmail: varchar('pending_email', { length: 255 }).notNull(),
    // SHA-256 (hex) of the one-time confirmation token emailed to pendingEmail.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('pending_email_changes_user_id_idx').on(table.userId),
    uniqueIndex('pending_email_changes_token_hash_idx').on(table.tokenHash),
  ],
)

/**
 * Public sign-up email verification that has not been confirmed yet.
 * Only the SHA-256 of the one-time token is stored. `email` is the address
 * the token was sent to. Confirming sets `users.email_verified` and deletes
 * the row, so the token cannot be reused.
 */
export const pendingEmailVerifications = pgTable(
  'pending_email_verifications',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Address the token was mailed to. Confirm rejects the token when this
    // no longer equals users.email.
    email: varchar('email', { length: 255 }).notNull(),
    // SHA-256 (hex) of the one-time token emailed to `email`.
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('pending_email_verifications_user_id_idx').on(table.userId),
    uniqueIndex('pending_email_verifications_token_hash_idx').on(table.tokenHash),
  ],
)

/**
 * Authenticator-app MFA for an account. The TOTP secret is stored only as
 * authenticated ciphertext; `enabled` stays false until a valid code is
 * confirmed. Additive: accounts with no row have MFA off.
 */
export const userMfa = pgTable(
  'user_mfa',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    totpCiphertext: text('totp_ciphertext').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    lastUsedStep: integer('last_used_step'),
    failedVerifyCount: integer('failed_verify_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { precision: 3, withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('user_mfa_user_id_idx').on(table.userId)],
)

/**
 * One-time recovery codes for MFA. Only an HMAC is stored; plaintext is
 * shown once at enrol or regenerate.
 */
export const userMfaRecoveryCodes = pgTable(
  'user_mfa_recovery_codes',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: varchar('code_hash', { length: 64 }).notNull(),
    usedAt: timestamp('used_at', { precision: 3, withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('user_mfa_recovery_codes_hash_idx').on(table.codeHash),
    index('user_mfa_recovery_codes_user_id_idx').on(table.userId),
  ],
)

/**
 * Half-authenticated sign-in waiting on TOTP or a recovery code.
 * The Better Auth session is held server-side (id only plus encrypted
 * Set-Cookie values) until the second step succeeds; the client never
 * receives a session cookie in this state.
 */
export const userMfaChallenges = pgTable(
  'user_mfa_challenges',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    sessionId: id('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    cookiesCiphertext: text('cookies_ciphertext').notNull(),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('user_mfa_challenges_token_hash_idx').on(table.tokenHash),
    uniqueIndex('user_mfa_challenges_user_id_idx').on(table.userId),
  ],
)

/**
 * WebAuthn passkeys for an account. Column names match Better Auth's
 * passkey plugin (`credentialID`, `publicKey`, `deviceType`, …) so the
 * drizzle adapter can map the `passkey` model onto this table. `lastUsedAt`
 * is extra and updated after a successful passkey sign-in.
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: id().primaryKey(),
    name: varchar('name', { length: 255 }),
    publicKey: text('public_key').notNull(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialID: varchar('credential_id', { length: 255 }).notNull(),
    counter: integer('counter').notNull(),
    deviceType: varchar('device_type', { length: 32 }).notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    aaguid: varchar('aaguid', { length: 36 }),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { precision: 3, withTimezone: true }),
  },
  (table) => [
    index('passkeys_user_id_idx').on(table.userId),
    uniqueIndex('passkeys_credential_id_idx').on(table.credentialID),
  ],
)

/** Account-security audit trail (MFA enrol, disable, recovery, lockout). */
export const accountSecurityEvents = pgTable(
  'account_security_events',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('account_security_events_user_id_idx').on(table.userId)],
)

export const workspaces = pgTable('workspaces', {
  id: id().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
  defaultSlaMinutes: varchar('default_sla_minutes', { length: 16 }).notNull().default('1440'),
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
    // SHA-256 (hex) of the one-time accept token sent in the invite email.
    // The token itself is never stored. Null only for invites created before
    // tokenised invites existed; those cannot be redeemed (re-invite instead).
    tokenHash: varchar('token_hash', { length: 64 }),
    // Set once, atomically, when the invite is redeemed (the "used" marker).
    acceptedAt: timestamp('accepted_at', { precision: 3, withTimezone: true }),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('invites_workspace_idx').on(table.workspaceId),
    index('invites_email_idx').on(table.email),
    uniqueIndex('invites_token_hash_idx').on(table.tokenHash),
  ],
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
    /** live = accepting requests; paused = no new requests; archived = hidden + read-only. */
    status: projectStatusEnum('status').notNull().default('live'),
    credentials: jsonb('credentials').$type<Record<string, unknown>>().notNull(),
    defaultAssigneeUserId: id('default_assignee_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    defaultSlaMinutes: varchar('default_sla_minutes', { length: 16 }).notNull().default('1440'),
    evidenceSinkType: varchar('evidence_sink_type', { length: 16 }).notNull().default('none'),
    evidenceSinkConfig: jsonb('evidence_sink_config').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('projects_workspace_idx').on(table.workspaceId),
    index('projects_workspace_status_idx').on(table.workspaceId, table.status),
  ],
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
    /**
     * The project API key that created this request (the requester). Scopes
     * requester cancel and the requester's pending list. Null for requests
     * created before this column existed, or when the key was deleted.
     */
    requesterKeyId: id('requester_key_id').references(() => projectApiKeys.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { precision: 3, withTimezone: true }),
    /** First shown to a reviewer who can decide (hitl-spec 5.2 `presented`). */
    presentedAt: timestamp('presented_at', { precision: 3, withTimezone: true }),
    presentedByUserId: id('presented_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('approvals_workspace_status_idx').on(table.workspaceId, table.status),
    index('approvals_workspace_status_updated_idx').on(table.workspaceId, table.status, table.updatedAt),
    index('approvals_project_status_idx').on(table.projectId, table.status),
    index('approvals_created_at_idx').on(table.createdAt),
    // Keyset list pages (inbox + requester pending): always filter workspace_id,
    // then ORDER BY created_at DESC, id DESC. Postgres DESC is NULLS FIRST;
    // .desc() alone is NULLS LAST and the planner will not use this index.
    // Leading workspace_id beats a (created_at, id) index; project_id is an
    // IN-list on inbox, so it is not leading.
    index('approvals_workspace_created_at_id_idx').on(
      table.workspaceId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('approvals_project_idempotency_idx').on(table.projectId, table.idempotencyKey),
    index('approvals_requester_key_status_idx').on(table.requesterKeyId, table.status),
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

/**
 * Expo push tokens for the reviewer app. A token belongs to one user;
 * re-registering an existing token moves it to the current user.
 * User-scoped (not a workspace tenant table).
 */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: id().primaryKey(),
    userId: id('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    platform: devicePlatformEnum('platform').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { precision: 3, withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('push_tokens_user_id_idx').on(table.userId)],
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
    /** Reviewer device/channel at decide time (EvidenceClient, tenant-encrypted). */
    client: jsonb('client').$type<Record<string, unknown>>(),
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

export const otelProtocolEnum = pgEnum('otel_protocol', ['http/protobuf', 'http/json'])

export const workspaceOtelEndpoints = pgTable(
  'workspace_otel_endpoints',
  {
    id: id().primaryKey(),
    workspaceId: id('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    endpoint: text('endpoint').notNull(),
    protocol: otelProtocolEnum('protocol').notNull().default('http/protobuf'),
    headers: jsonb('headers').$type<Record<string, unknown>>(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('workspace_otel_endpoints_workspace_idx').on(table.workspaceId)],
)

/**
 * Tier entitlements map: the minimum workspace plan that unlocks each
 * boolean feature. Seeded by migration 0015 (mirrors TIER_ENTITLEMENT_SEED
 * in @hitly/core). The application never hard-codes a tier check: every
 * feature gate reads this table through the single helper
 * `can(workspace, feature)` (apps/app/lib/tier-entitlements.ts).
 *
 * Moving a feature between tiers is one statement, no code change:
 *   UPDATE tier_entitlements SET min_plan = 'pro' WHERE feature = 'sso_google';
 * The row cache in the helper refreshes within its TTL (default 10s).
 * Missing rows deny (fail-closed), so DELETE removes a feature entirely.
 */
export const tierEntitlements = pgTable(
  'tier_entitlements',
  {
    feature: varchar('feature', { length: 64 }).primaryKey(),
    minPlan: varchar('min_plan', { length: 32 }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'tier_entitlements_min_plan_check',
      // Plan names come from WORKSPACE_PLANS (a compile-time constant).
      sql`${table.minPlan} in (${sql.raw(WORKSPACE_PLANS.map((plan) => `'${plan}'`).join(', '))})`,
    ),
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
  'workspace_otel_endpoints',
] as const
