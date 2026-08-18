import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { notifyHitly } from '../hitly'
import { verifyHitlyResume } from '@hitly/plugin-mastra'

const refundInputSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
})

const approvalStep = createStep({
  id: 'hitly-approval',
  description: 'Pause for a Hitly reviewer before issuing the refund.',
  inputSchema: refundInputSchema,
  outputSchema: refundInputSchema.extend({ approved: z.literal(true) }),
  resumeSchema: z
    .object({
      approved: z.boolean(),
      orderId: z.string().optional(),
      amount: z.number().optional(),
    })
    .passthrough(),
  suspendSchema: z.object({
    reason: z.string(),
  }),
  execute: async ({ inputData, resumeData, suspend, bail, runId }) => {
    const orderId = resumeData?.orderId ?? inputData.orderId
    const amount = resumeData?.amount ?? inputData.amount

    if (resumeData) {
      verifyHitlyResume(resumeData, { runId, required: true })
    }

    if (resumeData?.approved === false) {
      return bail({ reason: 'Reviewer rejected the refund.' })
    }

    if (!resumeData?.approved) {
      await notifyHitly({
        config: {
          kind: 'workflow',
          workflowId: 'refund-workflow',
          workflowName: 'Refund workflow',
          stepId: 'hitly-approval',
          stepName: 'Pause for a Hitly reviewer',
          action: { name: 'send-refund', args: { orderId, amount } },
          // Evidence fields for audit trail
          systemId: 'refund-workflow-prod',
          inventoryId: 'ai-inv-refund-workflow-v1',
          policyId: 'refund-over-100',
          policyRationale: 'Refunds over $100 require manager approval',
          riskTier: amount > 1000 ? 'high' : amount > 100 ? 'medium' : 'low',
          toolName: 'send_refund',
          sensitivity: ['financial'],
          dataCategories: ['transaction', 'customer'],
        },
        runId,
        contextMarkdown: `Refund of ${amount} for ${orderId}.`,
        suspendPayload: {
          reason: `Human approval required for ${amount > 1000 ? 'high-value' : 'standard'} refund.`,
        },
      })
      return await suspend({ reason: 'Human approval required in Hitly.' })
    }

    return { orderId, amount, approved: true as const }
  },
})

const issueRefundStep = createStep({
  id: 'issue-refund',
  description: 'Mock sending the refund after Hitly approval.',
  inputSchema: refundInputSchema.extend({ approved: z.literal(true) }),
  outputSchema: z.object({
    sent: z.literal(true),
    orderId: z.string(),
    amount: z.number(),
    message: z.string(),
  }),
  execute: async ({ inputData }) => ({
    sent: true as const,
    orderId: inputData.orderId,
    amount: inputData.amount,
    message: `Refund of ${inputData.amount} issued for order ${inputData.orderId}.`,
  }),
})

export const refundWorkflow = createWorkflow({
  id: 'refund-workflow',
  description: 'Workflow demo: a step suspends until Hitly approves the refund.',
  inputSchema: refundInputSchema,
  outputSchema: z.object({
    sent: z.boolean(),
    orderId: z.string(),
    amount: z.number(),
    message: z.string(),
  }),
})
  .then(approvalStep)
  .then(issueRefundStep)
  .commit()
