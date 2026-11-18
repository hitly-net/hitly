import { entitlementsForPlan, OSS_NAV_ITEMS, type HitlyEdition } from '@hitly/core'

/**
 * The billing seam, OSS form. There is no payment system in the open-source
 * edition, so no workspace ever has an active paid subscription and there is
 * no plan-change history. Destructive flows therefore never return 409 for a
 * subscription, and retention sweeps fall back to plain plan retention.
 */
export const ossBilling = {
  async hasActivePaidSubscription(_workspaceId: string): Promise<boolean> {
    return false
  },
  async getPlanChangedAt(_workspaceId: string): Promise<Date | null> {
    return null
  },
}

export const edition: HitlyEdition = {
  id: 'oss',
  entitlementsFor(workspace) {
    return entitlementsForPlan(workspace.plan)
  },
  navItems: OSS_NAV_ITEMS,
  billing: ossBilling,
}
