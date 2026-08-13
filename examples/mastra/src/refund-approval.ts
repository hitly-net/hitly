/**
 * Copy this step into a Mastra workflow. Full wiring: hitly.net/integrations/mastra
 */
import { notifyHitlyApproval } from '@hitly/plugin-mastra'
import { z } from 'zod'

export const refundInputSchema = z.object({
  orderId: z.string(),
  amount: z.number(),
})

export async function hitlyRefundApproval(args: {
  inputData: z.infer<typeof refundInputSchema>
  resumeData?: { approved?: boolean }
  runId: string
  suspend: (payload: { reason: string }) => Promise<never>
  bail: (payload: { reason: string }) => never
}) {
  if (args.resumeData?.approved === false) {
    return args.bail({ reason: 'Reviewer rejected the refund.' })
  }

  if (!args.resumeData?.approved) {
    await notifyHitlyApproval(
      {
        apiUrl: process.env.HITLY_API_URL!,
        apiKey: process.env.HITLY_API_KEY!,
        connectionId: process.env.HITLY_CONNECTION_ID!,
        mastraBaseUrl: process.env.MASTRA_BASE_URL!,
        workflowId: 'refund-workflow',
        action: { name: 'send-refund', args: args.inputData },
      },
      {
        runId: args.runId,
        suspendPayload: {
          reason: `Refund ${args.inputData.amount} for order ${args.inputData.orderId}`,
        },
      },
    )
    return args.suspend({ reason: 'Human approval required.' })
  }

  return { approved: true as const }
}
