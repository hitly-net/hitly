import { entitlementsForPlan, OSS_NAV_ITEMS, type HitlyEdition } from '@hitly/core'

export const edition: HitlyEdition = {
  id: 'oss',
  entitlementsFor(workspace) {
    return entitlementsForPlan(workspace.plan)
  },
  navItems: OSS_NAV_ITEMS,
}
