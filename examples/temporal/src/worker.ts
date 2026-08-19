import { NativeConnection, Worker } from '@temporalio/worker'
import * as activities from './activities'
import { getHitlyConfig } from './hitly'

async function run() {
  const config = getHitlyConfig()

  // Connect to Temporal server
  const connection = await NativeConnection.connect({
    address: config.temporalAddress,
  })

  // Create a worker
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: 'hitly-refund-queue',
    workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
    activities,
  })

  console.log('Worker started, listening on task queue: hitly-refund-queue')
  console.log(`Temporal address: ${config.temporalAddress}`)
  console.log(`Temporal namespace: ${config.temporalNamespace}`)
  console.log('HITLy integration active.')

  await worker.run()
}

run().catch((err) => {
  console.error('Worker error:', err)
  process.exit(1)
})
