import { OSS_ENTITLEMENTS, OSS_NAV_ITEMS, type HitlyEdition } from '@hitly/core'

export const edition: HitlyEdition = {
  id: 'oss',
  entitlementsFor() {
    return OSS_ENTITLEMENTS
  },
  navItems: OSS_NAV_ITEMS,
}
