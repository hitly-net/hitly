import { describe, it, mock, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  temporalPlugin,
  HITLY_TEMPORAL_SIGNAL,
  __setTemporalClientFactory,
  type TemporalClientFactory,
  type TemporalConnection,
  type TemporalWorkflowHandle,
} from './index'
import type { DecisionPayload, OriginRef, ResumeResponse } from '@hitly/core'

// Mock Temporal client components
const mockConnection: TemporalConnection = {
  close: mock.fn(async () => {}),
}

const mockWorkflowHandle: TemporalWorkflowHandle & {
  signal: ReturnType<typeof mock.fn>
  start?: ReturnType<typeof mock.fn>
} = {
  signal: mock.fn(async () => {}),
  // This should never be called (signal-only resume)
  start: mock.fn(async () => {}),
}

const mockClient = {
  getHandle: mock.fn(() => mockWorkflowHandle),
  // These should never be called (signal-only resume)
  start: mock.fn(async () => {}),
  signalWithStart: mock.fn(async () => {}),
}

const mockConnect = mock.fn(async () => mockConnection)

const mockFactory: TemporalClientFactory = {
  connect: mockConnect,
  createClient: mock.fn(() => mockClient),
}

describe('@hitly/plugin-temporal', () => {
  beforeEach(() => {
    // Install mock factory before each test
    __setTemporalClientFactory(mockFactory)
    // Reset all mock call counts
    mockConnect.mock.resetCalls()
    ;(mockConnection.close as any).mock.resetCalls()
    mockWorkflowHandle.signal.mock.resetCalls()
    if (mockWorkflowHandle.start) {
      mockWorkflowHandle.start.mock.resetCalls()
    }
    mockClient.getHandle.mock.resetCalls()
    ;(mockClient.start as any).mock.resetCalls()
    ;(mockClient.signalWithStart as any).mock.resetCalls()
    ;(mockFactory.createClient as any).mock.resetCalls()
  })
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
      // Create a failing factory for this test
      const failingFactory: TemporalClientFactory = {
        connect: mock.fn(async () => {
          throw new Error('Workflow not found')
        }),
        createClient: mock.fn(() => mockClient),
      }
      __setTemporalClientFactory(failingFactory)

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
    })

    it('should only call getHandle + signal, never start or signalWithStart', async () => {
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
      const getHandleCalls = (mockClient.getHandle as any).mock.calls
      assert.equal(getHandleCalls.length, 1)
      assert.equal((getHandleCalls as any)[0].arguments[0], 'refund-wf-abc')

      // Assert signal was called once
      const signalCalls = (mockWorkflowHandle.signal as any).mock.calls
      assert.equal(signalCalls.length, 1)

      // Assert start/signalWithStart were NEVER called
      const clientStartCalls = (mockClient.start as any).mock.calls
      const clientSignalWithStartCalls = (mockClient.signalWithStart as any).mock.calls
      const handleStartCalls = (mockWorkflowHandle.start! as any).mock.calls

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
      // Create a failing factory for this test
      const failingFactory: TemporalClientFactory = {
        connect: mock.fn(async () => {
          throw new Error('Connection refused')
        }),
        createClient: mock.fn(() => mockClient),
      }
      __setTemporalClientFactory(failingFactory)

      const result = await temporalPlugin.healthcheck({
        plugin: 'temporal',
        address: 'unreachable:7233',
      })

      assert.equal(result, 'error')
    })
  })
})
