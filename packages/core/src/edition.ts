export const FEATURES = ['billing', 'usage_metering', 'sso'] as const

export type Feature = (typeof FEATURES)[number]

export type EditionId = 'oss' | 'cloud'

export const WORKSPACE_PLANS = ['self-hosted', 'solo', 'pro', 'team', 'enterprise'] as const
export type WorkspacePlan = (typeof WORKSPACE_PLANS)[number]

export const CLOUD_PLANS = ['solo', 'pro', 'team', 'enterprise'] as const
export type CloudPlan = (typeof CLOUD_PLANS)[number]

export const HOUSEKEEPING_SCHEDULES = ['hourly', 'daily', 'weekly'] as const
export type HousekeepingSchedule = (typeof HOUSEKEEPING_SCHEDULES)[number]

/** Closed inbox items (decided / expired / cancelled) older than this are deleted. */
export const COMPLETED_RETENTION_DAYS: Record<CloudPlan, number> = {
  solo: 10,
  pro: 30,
  team: 365,
  enterprise: 1000,
}

export function isCloudPlan(plan: string): plan is CloudPlan {
  return (CLOUD_PLANS as readonly string[]).includes(plan)
}

/** `null` means keep completed items forever (self-hosted / unknown plan). */
export function completedRetentionDaysForPlan(plan: string): number | null {
  return isCloudPlan(plan) ? COMPLETED_RETENTION_DAYS[plan] : null
}

export interface Entitlements {
  features: Record<Feature, boolean>
  /** null means unlimited */
  maxApprovalsPerMonth: number | null
  /** null means unlimited */
  maxMembers: number | null
  auditRetentionDays: number
  /** null means keep completed inbox items forever */
  completedRetentionDays: number | null
}

export interface EditionNavItem {
  href: string
  label: string
  feature?: Feature
}

export type TenantDocument = Record<string, unknown>

export type ResolvedProjectApiKey = {
  key: {
    id: string
    projectId: string
    workspaceId: string
    name: string
    hashedKey: string
    prefix: string
  }
  project: {
    id: string
    workspaceId: string
    name: string
    plugin: string
    credentials: TenantDocument
    defaultAssigneeUserId: string | null
    defaultSlaMinutes: string
  }
}

export interface HitlyEdition {
  id: EditionId
  entitlementsFor(workspace: { plan: string }): Entitlements
  navItems: EditionNavItem[]
  /** Cloud: `SET LOCAL app.workspace_id` on the tenant transaction. OSS omits this. */
  applyTenantContext?(tx: object, workspaceId: string): Promise<void>
  encryptDocument?(workspaceId: string, value: TenantDocument): Promise<TenantDocument>
  decryptDocument?(workspaceId: string, value: TenantDocument): Promise<TenantDocument>
  onWorkspaceCreated?(workspaceId: string): Promise<void>
  resolveProjectApiKey?(hashedKey: string): Promise<ResolvedProjectApiKey | null>
  /**
   * Enterprise dedicated-DB seam. Waitlist always returns null (shared Postgres).
   * When a tenant pays for isolation, Cloud returns that workspace's connection string.
   */
  resolveDatabaseUrl?(workspace: { id: string; plan: string }): string | null
}

export class FeatureUnavailableError extends Error {
  readonly feature: Feature

  constructor(feature: Feature) {
    super(`Feature "${feature}" is not available in this Hitly edition`)
    this.name = 'FeatureUnavailableError'
    this.feature = feature
  }
}

export function hasFeature(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features[feature]
}

export function requireFeature(entitlements: Entitlements, feature: Feature): void {
  if (!hasFeature(entitlements, feature)) {
    throw new FeatureUnavailableError(feature)
  }
}

export const OSS_NAV_ITEMS: EditionNavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/projects', label: 'Projects' },
  { href: '/audit', label: 'Audit' },
]

export const OSS_ENTITLEMENTS: Entitlements = {
  features: {
    billing: false,
    usage_metering: false,
    sso: false,
  },
  maxApprovalsPerMonth: null,
  maxMembers: null,
  auditRetentionDays: 3650,
  completedRetentionDays: null,
}

export function entitlementsForPlan(plan: string): Entitlements {
  return {
    ...OSS_ENTITLEMENTS,
    completedRetentionDays: completedRetentionDaysForPlan(plan),
  }
}
