import { describe, it, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { temporalPlugin, HITLY_TEMPORAL_SIGNAL } from './index'
import type { DecisionPayload, OriginRef, ResumeResponse } from '@hitly/core'

// Mock the Temporal client module
const mockConnection = {
  connect: mock.fn(async () => mockConnection),
  close: mock.fn(async () => {}),
}

const mockWorkflowHandle = {
  signal: mock.fn(async () => {}),
  // These should never be called (signal-only resume)
  start: mock.fn(async () => {}),
}

const mockWorkflowClient = {
  getHandle: mock.fn(() => mockWorkflowHandle),
  // These should never be called (signal-only resume)
  start: mock.fn(async () => {}),
  signalWithStart: mock.fn(async () => {}),
}

// Mock the @temporalio/client module
const mockTemporalClient = {
  Connection: {
    connect: mockConnection.connect,
  },
  WorkflowClient: mock.fn(() => mockWorkflowClient),
}

// Replace the module imports
mock.module('@temporalio/client', {
  namedExports: mockTemporalClient,
})

describe('@hitly/plugin-temporal', () => {
  describe('ingest', () => {
    it('should ingest a Temporal approval with workflowId', () => {
      const raw = {
        plugin: 'temporal',
        projectId: 'prj_123',
        workflowId: 'refund-wf-abc123',
        address: 'localhost:7233',
        namespace: 'default',
        actionName: 'send-refund',
        args: { orderId: 'OR-1234', amount: 123.45 },
        contextMarkdown: 'Refund approval required',
      }

      const result = temporalPlugin.ingest(raw)

      assert.equal(result.action.name, 'send-refund')
      assert.deepEqual(result.action.args, { orderId: 'OR-1234', amount: 123.45 })
      assert.equal(result.allowedActions.accept, true)
      assert.equal(result.allowedActions.reject, true)
      assert.equal(result.contextMarkdown, 'Refund approval required')
      assert.equal(result.origin.plugin, 'temporal')
      assert.equal(result.origin.projectId, 'prj_123')
      assert.equal(result.origin.runId, 'refund-wf-abc123')
      assert.equal((result.origin.resumeHandle as any).workflowId, 'refund-wf-abc123')
      assert.equal((result.origin.resumeHandle as any).signal, HITLY_TEMPORAL_SIGNAL)
    })

    it('should throw when workflowId is missing', () => {
      const raw = {
        plugin: 'temporal',
        projectId: 'prj_123',
        address: 'localhost:7233',
        actionName: 'test',
      }

      assert.throws(() => {
        temporalPlugin.ingest(raw)
      }, /Temporal ingest requires workflowId/)
    })

    it('should throw when workflowId is empty string', () => {
      const raw = {
        plugin: 'temporal',
        projectId: 'prj_123',
        workflowId: '',
        address: 'localhost:7233',
        actionName: 'test',
      }

      assert.throws(() => {
        temporalPlugin.ingest(raw)
      }, /Temporal ingest requires workflowId/)
    })

    it('should ingest with evidence fields', () => {
      const raw = {
        projectId: 'prj_123',
        workflowId: 'refund-wf-abc',
        address: 'localhost:7233',
        actionName: 'send-refund',
        args: { orderId: 'OR-1234', amount: 123.45 },
        systemId: 'refund-workflow-prod',
        inventoryId: 'ai-inv-refund-workflow-v1',
        policyId: 'refund-over-100',
        policyRationale: 'High value refund',
        riskTier: 'high',
        toolName: 'send_refund',
        sensitivity: ['financial'],
        dataCategories: ['transaction', 'customer'],
      }

      const result = temporalPlugin.ingest(raw)

      assert.equal(result.systemId, 'refund-workflow-prod')
      assert.equal(result.inventoryId, 'ai-inv-refund-workflow-v1')
      assert.equal(result.policyId, 'refund-over-100')
      assert.equal(result.riskTier, 'high')
      assert.deepEqual(result.sensitivity, ['financial'])
      assert.deepEqual(result.dataCategories, ['transaction', 'customer'])
      assert.equal(result.origin.systemId, 'refund-workflow-prod')
    })

    it('should default namespace to "default"', () => {
      const raw = {
        projectId: 'prj_123',
        workflowId: 'wf-123',
        address: 'localhost:7233',
        actionName: 'test',
      }

      const result = temporalPlugin.ingest(raw)

      assert.equal((result.origin.resumeHandle as any).namespace, 'default')
    })
  })

  describe('resume', () => {
    it('should signal accept to Temporal workflow', async () => {
      // Reset mocks
      mockConnection.connect.mock.resetCalls()
      mockWorkflowHandle.signal.mock.resetCalls()

      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          address: 'localhost:7233',
          namespace: 'default',
          workflowId: 'refund-wf-abc',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await temporalPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 200)
      assert.deepEqual(result.resumeData, { decision: 'accept' })
      assert.equal((result.body as any).signaled, true)
      assert.equal((result.body as any).workflowId, 'refund-wf-abc')
      assert.equal((result.body as any).signal, HITLY_TEMPORAL_SIGNAL)

      // Verify workflow.signal was called
      const signalCalls = (mockWorkflowHandle.signal as any).mock.calls
      assert.equal(signalCalls.length, 1)
      const signalCall = signalCalls[0]
      assert.equal(signalCall.arguments[0], HITLY_TEMPORAL_SIGNAL)
      assert.deepEqual(signalCall.arguments[1], { decision: 'accept' })
    })

    it('should signal reject decision', async () => {
      mockWorkflowHandle.signal.mock.resetCalls()

      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          address: 'localhost:7233',
          namespace: 'default',
          workflowId: 'refund-wf-abc',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'reject',
      }

      await temporalPlugin.resume(origin, payload)

      const signalCalls = (mockWorkflowHandle.signal as any).mock.calls
      const signalCall = signalCalls[0]
      assert.deepEqual(signalCall.arguments[1], { decision: 'reject' })
    })

    it('should signal edit with args', async () => {
      mockWorkflowHandle.signal.mock.resetCalls()

      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          address: 'localhost:7233',
          namespace: 'default',
          workflowId: 'refund-wf-abc',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'edit',
        editedArgs: { orderId: 'OR-9999', amount: 99.99 },
      }

      await temporalPlugin.resume(origin, payload)

      const signalCalls = (mockWorkflowHandle.signal as any).mock.calls
      const signalCall = signalCalls[0]
      assert.deepEqual(signalCall.arguments[1], {
        decision: 'edit',
        args: { orderId: 'OR-9999', amount: 99.99 },
      })
    })

    it('should return error when address is missing', async () => {
      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          workflowId: 'refund-wf-abc',
          namespace: 'default',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await temporalPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 0)
      assert.equal(result.error, 'Temporal resume requires address and workflowId')
    })

    it('should return error when workflowId is missing', async () => {
      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          address: 'localhost:7233',
          namespace: 'default',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await temporalPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 0)
      assert.equal(result.error, 'Temporal resume requires address and workflowId')
    })

    it('should handle Temporal client errors', async () => {
      // Make signal throw an error
      const originalSignal = mockWorkflowHandle.signal
      mockWorkflowHandle.signal = mock.fn(async () => {
        throw new Error('Workflow not found')
      })

      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          address: 'localhost:7233',
          namespace: 'default',
          workflowId: 'refund-wf-abc',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await temporalPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 500)
      assert(result.error?.includes('Temporal signal failed'))
      assert(result.error?.includes('Workflow not found'))

      // Restore original
      mockWorkflowHandle.signal = originalSignal
    })

    it('should only call getHandle + signal, never start or signalWithStart', async () => {
      // Reset all mocks
      mockWorkflowClient.getHandle.mock.resetCalls()
      mockWorkflowHandle.signal.mock.resetCalls()
      mockWorkflowClient.start.mock.resetCalls()
      mockWorkflowClient.signalWithStart.mock.resetCalls()
      mockWorkflowHandle.start.mock.resetCalls()

      const origin: OriginRef = {
        plugin: 'temporal',
        projectId: 'prj_123',
        runId: 'refund-wf-abc',
        resumeHandle: {
          address: 'localhost:7233',
          namespace: 'default',
          workflowId: 'refund-wf-abc',
          signal: HITLY_TEMPORAL_SIGNAL,
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      await temporalPlugin.resume(origin, payload)

      // Assert getHandle was called once
      const getHandleCalls = (mockWorkflowClient.getHandle as any).mock.calls
      assert.equal(getHandleCalls.length, 1)
      assert.equal(getHandleCalls[0].arguments[0], 'refund-wf-abc')

      // Assert signal was called once
      const signalCalls = (mockWorkflowHandle.signal as any).mock.calls
      assert.equal(signalCalls.length, 1)

      // Assert start/signalWithStart were NEVER called
      const clientStartCalls = (mockWorkflowClient.start as any).mock.calls
      const clientSignalWithStartCalls = (mockWorkflowClient.signalWithStart as any).mock.calls
      const handleStartCalls = (mockWorkflowHandle.start as any).mock.calls

      assert.equal(clientStartCalls.length, 0, 'client.start should never be called')
      assert.equal(clientSignalWithStartCalls.length, 0, 'client.signalWithStart should never be called')
      assert.equal(handleStartCalls.length, 0, 'handle.start should never be called')
    })
  })

  describe('healthcheck', () => {
    it('should return error when address is missing', async () => {
      const result = await temporalPlugin.healthcheck({
        plugin: 'temporal',
      })

      assert.equal(result, 'error')
    })

    it('should return ok when connection succeeds', async () => {
      mockConnection.connect.mock.resetCalls()
      mockConnection.close.mock.resetCalls()

      const result = await temporalPlugin.healthcheck({
        plugin: 'temporal',
        address: 'localhost:7233',
      })

      assert.equal(result, 'ok')

      // Verify connection.close was called
      const closeCalls = (mockConnection.close as any).mock.calls
      assert.equal(closeCalls.length, 1)
    })

    it('should return error when connection fails', async () => {
      // Make connect throw an error
      const originalConnect = mockConnection.connect
      mockConnection.connect = mock.fn(async () => {
        throw new Error('Connection refused')
      })

      const result = await temporalPlugin.healthcheck({
        plugin: 'temporal',
        address: 'unreachable:7233',
      })

      assert.equal(result, 'error')

      // Restore original
      mockConnection.connect = originalConnect
    })
  })
})
