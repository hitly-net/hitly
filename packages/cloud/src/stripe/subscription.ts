import { billingUnavailable } from './unavailable'

export type StripeWorkspaceContext = {
  workspaceId: string
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
}

export async function GET(_request?: Request, _ctx?: StripeWorkspaceContext) {
  return billingUnavailable()
}

export async function POST(_request?: Request, _ctx?: StripeWorkspaceContext) {
  return billingUnavailable()
}
