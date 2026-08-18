import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { notifyHitly } from '../hitly'
import { verifyHitlyResume } from '@hitly/plugin-mastra'

const refundInputSchema = z.object({
  orderId: z.string().describe('Order to refund'),
  amount: z.number().describe('Refund amount'),
  contextMarkdown: z
    .string()
    .optional()
    .describe(
      'Markdown brief for the Hitly reviewer. Omit to use the default one-line summary. Prefer a longer explanation: why the refund, customer/order facts, and any policy notes.',
    ),
  externalUrls: z
    .array(z.string())
    .optional()
    .describe('Links the reviewer should open (order, ticket, policy). Use full https URLs.'),
  attachments: z
    .array(
      z.object({
        name: z.string().describe('File name shown to the reviewer, e.g. invoice.pdf'),
        url: z.string().optional().describe('Optional URL. PDF upload is not implemented yet.'),
        contentType: z.string().optional().describe('MIME type, e.g. application/pdf'),
      }),
    )
    .optional()
    .describe('Declared files for the reviewer. Hitly does not fetch attachments yet; pass a name (and url if you have one).'),
})

type AgentToolContext = {
  runId?: string
  agent?: {
    toolCallId: string
    resumeData?: { approved?: boolean; orderId?: string; amount?: number }
    suspend?: (payload: { reason: string }) => Promise<void>
  }
}

export const sendRefundTool = createTool({
  id: 'send-refund',
  description: 'Issue a customer refund. Always requires a human reviewer in Hitly before money is sent.',
  inputSchema: refundInputSchema,
  outputSchema: z.object({
    sent: z.boolean(),
    orderId: z.string(),
    amount: z.number(),
    message: z.string(),
  }),
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
  execute: async (inputData, context) => {
    const { runId, agent } = context as AgentToolContext
    const resumeData = agent?.resumeData
    const orderId = resumeData?.orderId ?? inputData.orderId
    const amount = resumeData?.amount ?? inputData.amount
    const contextMarkdown = inputData.contextMarkdown?.trim() || `Refund of ${amount} for ${orderId}.`
    const externalUrls = inputData.externalUrls?.map((url) => url.trim()).filter(Boolean)
    const attachments = inputData.attachments?.filter((file) => file.name.trim())

    if (resumeData) {
      verifyHitlyResume(resumeData, { runId, required: true })
    }

    if (resumeData?.approved === false) {
      return {
        sent: false,
        orderId,
        amount,
        message: 'Reviewer rejected the refund.',
      }
    }

    if (!resumeData?.approved) {
      if (!runId) {
        throw new Error('Mastra tool context is missing runId; cannot notify Hitly')
      }
      await notifyHitly({
        config: {
          kind: 'agent',
          agentId: 'refund-agent',
          agentName: 'Refund Agent',
          toolCallId: agent?.toolCallId,
          stepId: agent?.toolCallId ?? 'send-refund',
          stepName: 'send-refund',
          action: { name: 'send-refund', args: { orderId, amount } },
          // Evidence fields for audit trail
          systemId: 'refund-agent-prod',
          inventoryId: 'ai-inv-refund-agent-v2',
          policyId: 'refund-over-100',
          policyRationale: 'Refunds over $100 require manager approval',
          riskTier: amount > 1000 ? 'high' : amount > 100 ? 'medium' : 'low',
          toolName: 'send_refund',
          sensitivity: ['financial'],
          dataCategories: ['transaction', 'customer'],
        },
        runId,
        contextMarkdown,
        externalUrls: externalUrls?.length ? externalUrls : undefined,
        attachments: attachments?.length ? attachments : undefined,
      })
      if (!agent?.suspend) {
        throw new Error('Mastra tool context is missing suspend(); cannot wait for Hitly')
      }
      return await agent.suspend({ reason: 'Human approval required in Hitly.' })
    }

    return {
      sent: true,
      orderId,
      amount,
      message: `Refund of ${amount} issued for order ${orderId}.`,
    }
  },
})
