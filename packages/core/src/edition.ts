export const FEATURES = ['billing', 'usage_metering', 'sso'] as const

export type Feature = (typeof FEATURES)[number]

export type EditionId = 'oss' | 'cloud'

export interface Entitlements {
  features: Record<Feature, boolean>
  /** null means unlimited */
  maxApprovalsPerMonth: number | null
  /** null means unlimited */
  maxMembers: number | null
  auditRetentionDays: number
}

export interface EditionNavItem {
  href: string
  label: string
  feature?: Feature
}

export interface HitlyEdition {
  id: EditionId
  entitlementsFor(workspace: { plan: string }): Entitlements
  navItems: EditionNavItem[]
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
  { href: '/audit', label: 'Audit' },
  { href: '/settings/connections', label: 'Connections' },
  { href: '/settings/profile', label: 'Profile' },
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
}
