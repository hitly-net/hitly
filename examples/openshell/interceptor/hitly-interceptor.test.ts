/**
 * Tests for HITLy Gateway Interceptor (Reference Implementation)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HitlyInterceptor, type HitlyInterceptorConfig, type ApprovalStatus } from './hitly-interceptor'
import fetch from 'node-fetch'

// Mock fetch
vi.mock('node-fetch')
const mockFetch = fetch as any as ReturnType<typeof vi.fn>

describe('HitlyInterceptor', () => {
  let config: HitlyInterceptorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    config = {
      enabled: true,
      hitlyApiUrl: 'http://localhost:3001',
      hitlyApiKey: 'hitly_test123',
      hitlyProjectId: 'prj_test456',
      timeoutMs: 5000,
      failOpen: false,
    }
  })

  describe('config validation', () => {
    it('should validate config when enabled', () => {
      expect(() => new HitlyInterceptor(config)).not.toThrow()
    })

    it('should throw if API URL is missing', () => {
      config.hitlyApiUrl = ''
      expect(() => new HitlyInterceptor(config)).toThrow('HITLY_API_URL is required')
    })

    it('should throw if API key does not start with hitly_', () => {
      config.hitlyApiKey = 'invalid_key'
      expect(() => new HitlyInterceptor(config)).toThrow('HITLY_API_KEY must start with "hitly_"')
    })

    it('should throw if project ID does not start with prj_', () => {
      config.hitlyProjectId = 'invalid_id'
      expect(() => new HitlyInterceptor(config)).toThrow('HITLY_PROJECT_ID must start with "prj_"')
    })

    it('should not validate when disabled', () => {
      config.enabled = false
      config.hitlyApiUrl = ''
      expect(() => new HitlyInterceptor(config)).not.toThrow()
    })
  })

  describe('intercept - disabled', () => {
    it('should allow all requests when interceptor is disabled', async () => {
      config.enabled = false
      const interceptor = new HitlyInterceptor(config)

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
    })
  })

  describe('intercept - non-intercepted methods', () => {
    it('should allow GetDraftPolicy without querying HITLy', async () => {
      const interceptor = new HitlyInterceptor(config)

      const result = await interceptor.intercept({
        method: 'GetDraftPolicy',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe('intercept - ApproveDraftChunk', () => {
    it('should allow when HITLy decision is accept', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'decided',
        decision: 'accept',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
      expect(result.hitlyStatus).toBe('decided')
      expect(result.hitlyDecision).toBe('accept')
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/v1/approvals/by-run-id?runId=sandbox-123%3Achunk-456&plugin=openshell',
        expect.objectContaining({
          headers: expect.objectContaining({
            'authorization': 'Bearer hitly_test123',
          }),
        }),
      )
    })

    it('should deny when HITLy decision is reject (mismatch)', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'decided',
        decision: 'reject',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Decision mismatch')
      expect(result.reason).toContain('reject')
      expect(result.hitlyStatus).toBe('decided')
      expect(result.hitlyDecision).toBe('reject')
    })

    it('should deny when approval is pending', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'pending',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('still pending')
      expect(result.hitlyStatus).toBe('pending')
    })

    it('should allow when status is failed_resume but decision is accept', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'failed_resume',
        decision: 'accept',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
      expect(result.hitlyStatus).toBe('failed_resume')
      expect(result.hitlyDecision).toBe('accept')
    })

    it('should deny when approval is not found', async () => {
      const interceptor = new HitlyInterceptor(config)

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('No approval found')
    })
  })

  describe('intercept - RejectDraftChunk', () => {
    it('should allow when HITLy decision is reject', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'decided',
        decision: 'reject',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'RejectDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
      expect(result.hitlyStatus).toBe('decided')
      expect(result.hitlyDecision).toBe('reject')
    })

    it('should allow when HITLy decision is cancel', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'decided',
        decision: 'cancel',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'RejectDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
      expect(result.hitlyStatus).toBe('decided')
      expect(result.hitlyDecision).toBe('cancel')
    })

    it('should deny when HITLy decision is accept (mismatch)', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'decided',
        decision: 'accept',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'RejectDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Decision mismatch')
      expect(result.reason).toContain('accept')
      expect(result.hitlyStatus).toBe('decided')
      expect(result.hitlyDecision).toBe('accept')
    })
  })

  describe('intercept - fail-open mode', () => {
    it('should allow requests when HITLy API is unreachable and failOpen is true', async () => {
      config.failOpen = true
      const interceptor = new HitlyInterceptor(config)

      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(true)
      expect(result.reason).toContain('HITLy API error (fail-open)')
    })

    it('should deny requests when HITLy API is unreachable and failOpen is false', async () => {
      config.failOpen = false
      const interceptor = new HitlyInterceptor(config)

      mockFetch.mockRejectedValueOnce(new Error('Connection refused'))

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('HITLy API unreachable (fail-closed)')
    })
  })

  describe('intercept - timeout', () => {
    it('should deny when HITLy API times out', async () => {
      config.timeoutMs = 100
      const interceptor = new HitlyInterceptor(config)

      // Mock a slow response
      mockFetch.mockImplementationOnce(() => 
        new Promise((resolve) => setTimeout(resolve, 500))
      )

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('timeout')
    })
  })

  describe('intercept - edge cases', () => {
    it('should deny when approval is expired', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'expired',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('expired')
    })

    it('should deny when approval is cancelled without decision', async () => {
      const interceptor = new HitlyInterceptor(config)

      const approval: ApprovalStatus = {
        id: 'apr_xyz',
        status: 'cancelled',
        runId: 'sandbox-123:chunk-456',
      }

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => approval,
      })

      const result = await interceptor.intercept({
        method: 'ApproveDraftChunk',
        workspace: 'test-workspace',
        sandbox: 'sandbox-123',
        chunkId: 'chunk-456',
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('cancelled without a decision')
    })
  })
})
