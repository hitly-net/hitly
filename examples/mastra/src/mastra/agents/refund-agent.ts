import { Agent } from '@mastra/core/agent'
import { Memory } from '@mastra/memory'
import { localModel } from '../model'
import { sendRefundTool } from '../tools/send-refund-tool'

export const refundAgent = new Agent({
  id: 'refund-agent',
  name: 'Refund Agent',
  description: 'Chat demo: issuing a refund pauses for Hitly approval.',
  instructions: `You help support agents issue refunds.

When a user wants to refund an order, collect orderId and amount if they are missing, then call the send-refund tool. Write contextMarkdown for the Hitly reviewer: a markdown explanation of why the refund should be issued, with any facts from the conversation. Put order, ticket, or policy links in externalUrls. You may declare attachments by name (PDF upload is not implemented yet). If you omit contextMarkdown, the tool sends a one-line default.

Do not claim the refund was sent until the tool returns sent: true.

If the tool is waiting for approval, tell the user a reviewer must accept the refund in Hitly. If the reviewer rejects it, explain that and do not retry unless they ask.`,
  model: localModel(),
  tools: { sendRefundTool },
  memory: new Memory({
    options: {
      lastMessages: 20,
    },
  }),
})
