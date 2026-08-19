import { describe, it, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { hermesPlugin } from './index'
import type { DecisionPayload, OriginRef, ResumeResponse } from '@hitly/core'

describe('@hitly/plugin-hermes', () => {
  describe('ingest', () => {
    it('should ingest a Hermes command approval with resumeUrl', () => {
      const raw = {
        plugin: 'hermes',
        projectId: 'prj_123',
        kind: 'command',
        runId: 'cmd_abc',
        requestId: 'req_xyz',
        command: 'rm -rf /important',
        description: 'Delete important files',
        resumeUrl: 'http://localhost:8080/hitly-callback',
        metadata: { sessionId: 'sess_123' },
      }

      const result = hermesPlugin.ingest(raw)

      assert.equal(result.action.name, 'hermes-approval')
      assert.equal(result.action.args.command, 'rm -rf /important')
      assert.equal(result.allowedActions.accept, true)
      assert.equal(result.allowedActions.reject, true)
      assert.equal(result.origin.plugin, 'hermes')
      assert.equal(result.origin.projectId, 'prj_123')
      assert.equal(result.origin.runId, 'cmd_abc')
      assert.equal(result.origin.resumeHandle.resumeUrl, 'http://localhost:8080/hitly-callback')
      assert.deepEqual(result.origin.resumeHandle.metadata, { sessionId: 'sess_123' })
      assert.deepEqual(result.metadata, { sessionId: 'sess_123' })
    })

    it('should ingest a Hermes kanban block with resumeUrl', () => {
      const raw = {
        plugin: 'hermes',
        projectId: 'prj_123',
        kind: 'kanban',
        taskId: 'task_456',
        profileName: 'assistant-dev',
        kanbanStatus: 'blocked',
        reason: 'Need approval for API call',
        resumeUrl: 'http://localhost:8080/kanban-callback',
      }

      const result = hermesPlugin.ingest(raw)

      assert.equal(result.action.name, 'kanban-block')
      assert.equal(result.action.args.taskId, 'task_456')
      assert.equal(result.allowedActions.respond, true)
      assert.equal(result.origin.plugin, 'hermes')
      assert.equal(result.origin.resumeHandle.resumeUrl, 'http://localhost:8080/kanban-callback')
    })

    it('should throw when resumeUrl is missing', () => {
      const raw = {
        plugin: 'hermes',
        projectId: 'prj_123',
        runId: 'cmd_abc',
        command: 'ls -la',
      }

      assert.throws(() => {
        hermesPlugin.ingest(raw)
      }, /Hermes ingest requires resumeUrl/)
    })

    it('should throw when runId is missing for command', () => {
      const raw = {
        plugin: 'hermes',
        projectId: 'prj_123',
        kind: 'command',
        command: 'test',
        resumeUrl: 'http://localhost:8080/callback',
      }

      assert.throws(() => {
        hermesPlugin.ingest(raw)
      }, /Hermes command ingest requires runId/)
    })

    it('should throw when taskId is missing for kanban', () => {
      const raw = {
        plugin: 'hermes',
        projectId: 'prj_123',
        kind: 'kanban',
        resumeUrl: 'http://localhost:8080/callback',
      }

      assert.throws(() => {
        hermesPlugin.ingest(raw)
      }, /Hermes kanban ingest requires taskId/)
    })
  })

  describe('resume', () => {
    it('should POST accept to resumeUrl', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true }),
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'hermes',
        projectId: 'prj_123',
        runId: 'cmd_abc',
        resumeHandle: {
          kind: 'command',
          runId: 'cmd_abc',
          resumeUrl: 'http://localhost:8080/hitly-callback',
          metadata: { sessionId: 'sess_123' },
          approvalId: 'apr_xyz',
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await hermesPlugin.resume(origin, payload)) as ResumeResponse

      const mockCalls = (mockFetch as any).mock.calls
      assert.equal(mockCalls.length, 1)
      const call = mockCalls[0]
      assert.equal(call.arguments[0], 'http://localhost:8080/hitly-callback')
      const fetchOptions = call.arguments[1] as RequestInit
      assert.equal(fetchOptions.method, 'POST')
      const body = JSON.parse(fetchOptions.body as string)
      assert.equal(body.decision, 'accept')
      assert.equal(body.id, 'apr_xyz')
      assert.deepEqual(body.metadata, { sessionId: 'sess_123' })

      assert.equal(result.status, 200)
      assert.deepEqual(result.body, { success: true })
    })

    it('should POST reject with response to resumeUrl', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{}',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'hermes',
        projectId: 'prj_123',
        runId: 'task_456:blocked',
        resumeHandle: {
          kind: 'kanban',
          taskId: 'task_456',
          runId: 'task_456:blocked',
          resumeUrl: 'http://localhost:8080/kanban-callback',
          metadata: {},
        },
      }

      const payload: DecisionPayload = {
        decision: 'reject',
        response: 'Not approved at this time',
      }

      await hermesPlugin.resume(origin, payload)

      const mockCalls = (mockFetch as any).mock.calls
      const call = mockCalls[0]
      const fetchOptions = call.arguments[1] as RequestInit
      const body = JSON.parse(fetchOptions.body as string)
      assert.equal(body.decision, 'reject')
      assert.equal(body.response, 'Not approved at this time')
    })

    it('should return error when resumeUrl is missing and not call fetch', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{}',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'hermes',
        projectId: 'prj_123',
        runId: 'cmd_abc',
        resumeHandle: {
          kind: 'command',
          runId: 'cmd_abc',
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await hermesPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 0)
      assert(result.error?.includes('Hermes resume requires resumeUrl'))
      assert(result.error?.includes('Origin should wait on callback'))
      
      // Verify fetch was never called
      const mockCalls = (mockFetch as any).mock.calls
      assert.equal(mockCalls.length, 0, 'fetch should not be called when resumeUrl is missing')
    })

    it('should handle HTTP errors from resumeUrl', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'hermes',
        projectId: 'prj_123',
        runId: 'cmd_abc',
        resumeHandle: {
          kind: 'command',
          runId: 'cmd_abc',
          resumeUrl: 'http://localhost:8080/hitly-callback',
          metadata: {},
        },
      }

      const payload: DecisionPayload = {
        decision: 'accept',
      }

      const result = (await hermesPlugin.resume(origin, payload)) as ResumeResponse

      assert.equal(result.status, 500)
      assert(result.error?.includes('Hermes resume failed (500)'))
      assert(result.error?.includes('Internal Server Error'))
    })

    it('should include editedArgs when provided', async () => {
      const mockFetch = mock.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{}',
      })) as unknown as typeof fetch
      global.fetch = mockFetch

      const origin: OriginRef = {
        plugin: 'hermes',
        projectId: 'prj_123',
        runId: 'cmd_abc',
        resumeHandle: {
          kind: 'command',
          runId: 'cmd_abc',
          resumeUrl: 'http://localhost:8080/hitly-callback',
          metadata: {},
        },
      }

      const payload: DecisionPayload = {
        decision: 'edit',
        editedArgs: { command: 'ls -l' },
      }

      await hermesPlugin.resume(origin, payload)

      const mockCalls = (mockFetch as any).mock.calls
      const call = mockCalls[0]
      const fetchOptions = call.arguments[1] as RequestInit
      const body = JSON.parse(fetchOptions.body as string)
      assert.equal(body.decision, 'edit')
      assert.deepEqual(body.editedArgs, { command: 'ls -l' })
    })
  })

  describe('healthcheck', () => {
    it('should return ok', async () => {
      const result = await hermesPlugin.healthcheck({
        plugin: 'hermes',
      })

      assert.equal(result, 'ok')
    })
  })
})
