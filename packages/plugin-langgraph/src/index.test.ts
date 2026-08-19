import { describe, it, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { langgraphPlugin } from './index'
import type { DecisionPayload, OriginRef, ResumeResponse } from '@hitly/core'

describe('@hitly/plugin-langgraph', () => {
  describe('ingest', () => {
    it('should ingest a HumanInterrupt with action_request', () => {
      const raw = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        threadId: 'thread_abc',
        deploymentUrl: 'http://localhost:2024',
        graphId: 'refund-graph',
        action_request: {
          action: 'send-refund',
          args: { orderId: 'OR-1234', amount: 123.45 },
        },
        config: {
          allow_accept: true,
          allow_ignore: true,
        },
        description: 'Refund approval required',
      }

      const result = langgraphPlugin.ingest(raw)

      assert.equal(result.action.name, 'send-refund')
      assert.deepEqual(result.action.args, { orderId: 'OR-1234', amount: 123.45 })
      assert.equal(result.allowedActions.accept, true)
      assert.equal(result.allowedActions.reject, true)
      assert.equal(result.contextMarkdown, 'Refund approval required')
      assert.equal(result.origin.plugin, 'langgraph')
      assert.equal(result.origin.projectId, 'prj_123')
      assert.equal(result.origin.runId, 'thread_abc')
    })

    it('should throw when threadId is missing', () => {
      const raw = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        // threadId is missing
        deploymentUrl: 'http://localhost:2024',
        action_request: { action: 'test' },
      }

      assert.throws(() => {
        langgraphPlugin.ingest(raw)
      }, /LangGraph ingest requires threadId/)
    })

    it('should throw when threadId is empty string', () => {
      const raw = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        threadId: '',
        deploymentUrl: 'http://localhost:2024',
        action_request: { action: 'test' },
      }

      assert.throws(() => {
        langgraphPlugin.ingest(raw)
      }, /LangGraph ingest requires threadId/)
    })

    it('should ingest with evidence fields', () => {
      const raw = {
        projectId: 'prj_123',
        threadId: 'thread_abc',
        deploymentUrl: 'http://localhost:2024',
        action_request: { action: 'refund' },
        systemId: 'refund-graph-prod',
        inventoryId: 'ai-inv-refund-v1',
        policyId: 'refund-over-100',
        policyRationale: 'High value refund',
        riskTier: 'high',
        toolName: 'send_refund',
        sensitivity: ['financial'],
        dataCategories: ['transaction', 'customer'],
      }

      const result = langgraphPlugin.ingest(raw)

      assert.equal(result.systemId, 'refund-graph-prod')
      assert.equal(result.inventoryId, 'ai-inv-refund-v1')
      assert.equal(result.policyId, 'refund-over-100')
      assert.equal(result.riskTier, 'high')
      assert.deepEqual(result.sensitivity, ['financial'])
      assert.deepEqual(result.dataCategories, ['transaction', 'customer'])
      assert.equal(result.origin.systemId, 'refund-graph-prod')
    })

    it('should map allow_ignore to reject', () => {
      const raw = {
        projectId: 'prj_123',
        threadId: 'thread_abc',
        deploymentUrl: 'http://localhost:2024',
        action_request: { action: 'test' },
        config: {
          allow_ignore: true,
        },
      }

      const result = langgraphPlugin.ingest(raw)

      assert.equal(result.allowedActions.reject, true)
      assert.equal(result.allowedActions.ignore, true)
    })
  })

  describe('resume', () => {
    it('should POST accept to LangGraph Platform API', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'success' }),
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        runId: 'thread_abc',
        resumeHandle: {
          deploymentUrl: 'http://localhost:2024',
          threadId: 'thread_abc',
          assistantId: 'refund-graph',
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await langgraphPlugin.resume(origin, payload)) as ResumeResponse

      const mockCalls = (mockFetch as any).mock.calls
      assert.equal(mockCalls.length, 1)
      const call = mockCalls[0]
      assert.equal(call.arguments[0], 'http://localhost:2024/threads/thread_abc/runs/wait')
      const fetchOptions = call.arguments[1] as RequestInit
      assert.equal(fetchOptions.method, 'POST')
      const body = JSON.parse(fetchOptions.body as string)
      assert.equal(body.assistant_id, 'refund-graph')
      assert.deepEqual(body.command.resume, { type: 'accept' })

      assert.equal(result.status, 200)
      assert.deepEqual(result.body, { status: 'success' })
    })

    it('should POST edit with args to LangGraph Platform API', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{}',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        runId: 'thread_abc',
        resumeHandle: {
          deploymentUrl: 'http://localhost:2024',
          threadId: 'thread_abc',
          graphId: 'refund-graph',
        },
      }

      const payload: DecisionPayload = {
        decision: 'edit',
        editedArgs: { orderId: 'OR-9999', amount: 99.99 },
      }

      await langgraphPlugin.resume(origin, payload)

      const mockCalls = (mockFetch as any).mock.calls
      const call = mockCalls[0]
      const fetchOptions = call.arguments[1] as RequestInit
      const body = JSON.parse(fetchOptions.body as string)
      assert.deepEqual(body.command.resume, {
        type: 'edit',
        args: { orderId: 'OR-9999', amount: 99.99 },
      })
    })

    it('should POST ignore for reject decision', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{}',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        runId: 'thread_abc',
        resumeHandle: {
          deploymentUrl: 'http://localhost:2024',
          threadId: 'thread_abc',
          assistantId: 'refund-graph',
        },
      }

      const payload: DecisionPayload = {
        decision: 'reject',
      }

      await langgraphPlugin.resume(origin, payload)

      const mockCalls = (mockFetch as any).mock.calls
      const call = mockCalls[0]
      const fetchOptions = call.arguments[1] as RequestInit
      const body = JSON.parse(fetchOptions.body as string)
      assert.deepEqual(body.command.resume, { type: 'ignore' })
    })

    it('should include Authorization header when token is provided', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{}',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        runId: 'thread_abc',
        resumeHandle: {
          deploymentUrl: 'http://localhost:2024',
          threadId: 'thread_abc',
          assistantId: 'refund-graph',
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      await langgraphPlugin.resume(origin, payload, {
        plugin: 'langgraph',
        token: 'test_token',
      })

      const mockCalls = (mockFetch as any).mock.calls
      const call = mockCalls[0]
      const fetchOptions = call.arguments[1] as RequestInit
      assert.equal((fetchOptions.headers as Record<string, string>).authorization, 'Bearer test_token')
    })

    it('should return error when deploymentUrl is missing', async () => {
      const origin: OriginRef = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        runId: 'thread_abc',
        resumeHandle: {
          threadId: 'thread_abc',
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await langgraphPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 0)
      assert.equal(result.error, 'LangGraph resume requires deploymentUrl and threadId')
    })

    it('should handle HTTP errors', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'langgraph',
        projectId: 'prj_123',
        runId: 'thread_abc',
        resumeHandle: {
          deploymentUrl: 'http://localhost:2024',
          threadId: 'thread_abc',
          assistantId: 'refund-graph',
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await langgraphPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 500)
      assert(result.error?.includes('LangGraph resume failed (500)'))
    })
  })

  describe('healthcheck', () => {
    it('should return ok when /ok endpoint is available', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const result = await langgraphPlugin.healthcheck({
        plugin: 'langgraph',
        baseUrl: 'http://localhost:2024',
      })

      assert.equal(result, 'ok')
      const mockCalls = (mockFetch as any).mock.calls
      assert.equal(mockCalls[0].arguments[0], 'http://localhost:2024/ok')
    })

    it('should try /info when /ok fails', async () => {
      let callCount = 0
      const mockFetch = mock.fn(async () => {
        callCount++
        return {
          ok: callCount === 2,
        }
      }) as unknown as typeof fetch
      global.fetch = mockFetch

      const result = await langgraphPlugin.healthcheck({
        plugin: 'langgraph',
        baseUrl: 'http://localhost:2024',
      })

      assert.equal(result, 'ok')
      const mockCalls = (mockFetch as any).mock.calls
      assert.equal(mockCalls.length, 2)
      assert.equal(mockCalls[1].arguments[0], 'http://localhost:2024/info')
    })

    it('should return error when baseUrl is missing', async () => {
      const result = await langgraphPlugin.healthcheck({
        plugin: 'langgraph',
      })

      assert.equal(result, 'error')
    })
  })
})
