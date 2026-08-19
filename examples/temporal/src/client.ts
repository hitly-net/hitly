import { Connection, Client } from '@temporalio/client'
import { refundWorkflow } from './workflows'
import { getHitlyConfig } from './hitly'

async function run() {
  const config = getHitlyConfig()

  // Connect to Temporal server
  const connection = await Connection.connect({
    address: config.temporalAddress,
  })

  const client = new Client({ connection, namespace: config.temporalNamespace })

  // Start a refund workflow
  const workflowId = `refund-OR-1234`
  const handle = await client.workflow.start(refundWorkflow, {
    taskQueue: 'hitly-refund-queue',
    workflowId,
    args: [
      {
        orderId: 'OR-1234',
        amount: 123.45,
      },
    ],
  })

  console.log(`Started workflow ${handle.workflowId}`)
  console.log(`Workflow is running. Open HITLy inbox at http://localhost:3001/inbox to approve or reject.`)
  console.log(`Waiting for workflow to complete...`)

  // Wait for workflow to complete
  const result = await handle.result()
  console.log('Workflow result:', result)

  await connection.close()
}

run().catch((err) => {
  console.error('Client error:', err)
  process.exit(1)
})
