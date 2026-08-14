import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { refundAgent } from './agents/refund-agent'
import { refundWorkflow } from './workflows/refund-workflow'

export const mastra = new Mastra({
  agents: { refundAgent },
  workflows: { refundWorkflow },
  storage: new LibSQLStore({
    id: 'hitly-mastra-demo',
    url: 'file:./mastra.db',
  }),
})
