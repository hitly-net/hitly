import { billingUnavailable } from './unavailable'

export type StripeWorkspaceContext = {
  workspaceId: string
  stripeCustomerId?: string | null
}

export async function POST(_request?: Request, _ctx?: StripeWorkspaceContext) {
  return billingUnavailable()
}
