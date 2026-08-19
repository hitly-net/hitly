import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow'
import type * as activities from './activities'
import type { RefundInput, HitlyDecision } from './types'

// Proxy activities with 60s timeout
const { notifyHitlyActivity, issueRefundActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
})

// Define the hitly.decision signal
export const hitlyDecisionSignal = defineSignal<[HitlyDecision]>('hitly.decision')

/**
 * Refund workflow that pauses for HITLy approval via condition() and signal.
 * 
 * HITLy does NOT hold a worker. Resume is signal only (hitly.decision).
 * No start, no signal-with-start.
 */
export async function refundWorkflow(input: RefundInput): Promise<string> {
  let decision: HitlyDecision | undefined = undefined

  // Set up signal handler
  setHandler(hitlyDecisionSignal, (payload: HitlyDecision) => {
    console.log('Received hitly.decision signal:', payload)
    decision = payload
  })

  // Notify HITLy (activity POSTs to HITLy)
  const workflowId = (globalThis as any).workflowInfo?.().workflowId ?? 'unknown'
  await notifyHitlyActivity({
    workflowId,
    orderId: input.orderId,
    amount: input.amount,
  })

  console.log('Waiting for HITLy decision via condition()...')

  // Wait for signal with a timeout (5 minutes)
  const signalReceived = await condition(() => decision !== undefined, '5m')

  if (!signalReceived) {
    throw new Error('Timeout waiting for HITLy decision')
  }

  if (!decision) {
    throw new Error('No decision received')
  }

  // Check decision
  if (decision.decision === 'reject') {
    console.log('Refund rejected by HITLy reviewer')
    return `Refund rejected. No refund issued for order ${input.orderId}.`
  }

  // Apply edited args if present
  const finalOrderId = decision.args?.orderId ?? input.orderId
  const finalAmount = decision.args?.amount ?? input.amount

  // Issue refund
  const result = await issueRefundActivity({
    orderId: finalOrderId,
    amount: finalAmount,
  })

  return result
}
