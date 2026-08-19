import type { NotifyHitlyInput } from './types'
import { getHitlyConfig } from './hitly'

/**
 * Activity that notifies HITLy about a pending approval.
 * This POSTs to HITLy /api/v1/approvals with the Temporal workflow context.
 */
export async function notifyHitlyActivity(input: NotifyHitlyInput): Promise<void> {
  const config = getHitlyConfig()

  const payload = {
    plugin: 'temporal',
    projectId: config.projectId,
    workflowId: input.workflowId,
    address: config.temporalAddress,
    namespace: config.temporalNamespace,
    actionName: 'send-refund',
    args: {
      orderId: input.orderId,
      amount: input.amount,
    },
    contextMarkdown: `Refund of $${input.amount} for order ${input.orderId}. ${input.amount > 1000 ? 'High-value' : 'Standard'} refund requires approval.`,
    // Evidence fields for audit trail
    systemId: 'refund-workflow-prod',
    inventoryId: 'ai-inv-refund-workflow-v1',
    policyId: 'refund-over-100',
    policyRationale: 'Refunds over $100 require manager approval',
    riskTier: input.amount > 1000 ? 'high' : input.amount > 100 ? 'medium' : 'low',
    toolName: 'send_refund',
    sensitivity: ['financial'],
    dataCategories: ['transaction', 'customer'],
  }

  const response = await fetch(`${config.apiUrl}/api/v1/approvals`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`HITLy ingest failed (${response.status}): ${text}`)
  }
}

/**
 * Activity that mock-issues a refund after approval.
 */
export async function issueRefundActivity(input: { orderId: string; amount: number }): Promise<string> {
  // Mock refund issuance
  console.log(`[MOCK] Issuing refund of $${input.amount} for order ${input.orderId}`)
  return `Refund of $${input.amount} issued for order ${input.orderId}.`
}
