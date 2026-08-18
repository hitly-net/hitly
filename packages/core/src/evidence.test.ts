import { describe, it, expect } from '@jest/globals'
import { canonicalJson, hashActionArgs, hashEvidenceContent, sha256Hex, type EvidenceEvent } from './evidence'

describe('evidence utilities', () => {
  describe('canonicalJson', () => {
    it('sorts object keys', () => {
      const obj = { z: 1, a: 2, m: 3 }
      const canonical = canonicalJson(obj)
      expect(canonical).toBe('{"a":2,"m":3,"z":1}')
    })

    it('recursively sorts nested objects', () => {
      const obj = { z: { y: 1, a: 2 }, a: { z: 3, b: 4 } }
      const canonical = canonicalJson(obj)
      expect(canonical).toBe('{"a":{"b":4,"z":3},"z":{"a":2,"y":1}}')
    })

    it('preserves array order', () => {
      const obj = { items: [3, 1, 2] }
      const canonical = canonicalJson(obj)
      expect(canonical).toBe('{"items":[3,1,2]}')
    })

    it('handles nested arrays with objects', () => {
      const obj = { items: [{ z: 1, a: 2 }, { b: 3 }] }
      const canonical = canonicalJson(obj)
      expect(canonical).toBe('{"items":[{"a":2,"z":1},{"b":3}]}')
    })
  })

  describe('sha256Hex', () => {
    it('produces consistent hash', async () => {
      const input = 'hello world'
      const hash1 = await sha256Hex(input)
      const hash2 = await sha256Hex(input)
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it('produces different hash for different input', async () => {
      const hash1 = await sha256Hex('hello')
      const hash2 = await sha256Hex('world')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('hashActionArgs', () => {
    it('produces same hash for same args regardless of key order', async () => {
      const args1 = { z: 1, a: 2, m: 3 }
      const args2 = { a: 2, m: 3, z: 1 }
      const hash1 = await hashActionArgs(args1)
      const hash2 = await hashActionArgs(args2)
      expect(hash1).toBe(hash2)
    })

    it('produces different hash for different args', async () => {
      const args1 = { amount: 100 }
      const args2 = { amount: 200 }
      const hash1 = await hashActionArgs(args1)
      const hash2 = await hashActionArgs(args2)
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('hashEvidenceContent', () => {
    it('excludes content_sha256 from hash calculation', async () => {
      const event: EvidenceEvent = {
        spec: 'hitly.evidence.v1',
        event_id: 'evt_123',
        approval_id: 'apr_456',
        event_type: 'requested',
        seq: 1,
        occurred_at: '2024-01-01T00:00:00.000Z',
        origin: {
          plugin: 'mastra',
          projectId: 'prj_789',
          runId: 'run_abc',
        },
        action: {
          name: 'test',
          args: {},
          proposed_sha256: 'abc123',
        },
        retention: {
          min_days: 180,
        },
        integrity: {
          alg: 'sha256',
          content_sha256: 'should-be-excluded',
        },
      }

      const hash1 = await hashEvidenceContent(event)
      event.integrity.content_sha256 = 'different-value'
      const hash2 = await hashEvidenceContent(event)

      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it('produces different hash if other fields change', async () => {
      const event: EvidenceEvent = {
        spec: 'hitly.evidence.v1',
        event_id: 'evt_123',
        approval_id: 'apr_456',
        event_type: 'requested',
        seq: 1,
        occurred_at: '2024-01-01T00:00:00.000Z',
        origin: {
          plugin: 'mastra',
          projectId: 'prj_789',
          runId: 'run_abc',
        },
        action: {
          name: 'test',
          args: {},
          proposed_sha256: 'abc123',
        },
        retention: {
          min_days: 180,
        },
        integrity: {
          alg: 'sha256',
          content_sha256: '',
        },
      }

      const hash1 = await hashEvidenceContent(event)

      event.seq = 2
      const hash2 = await hashEvidenceContent(event)

      expect(hash1).not.toBe(hash2)
    })

    it('produces same hash regardless of field order', async () => {
      const event1: EvidenceEvent = {
        spec: 'hitly.evidence.v1',
        event_id: 'evt_123',
        approval_id: 'apr_456',
        event_type: 'requested',
        seq: 1,
        occurred_at: '2024-01-01T00:00:00.000Z',
        origin: {
          plugin: 'mastra',
          projectId: 'prj_789',
          runId: 'run_abc',
        },
        action: {
          name: 'test',
          args: {},
          proposed_sha256: 'abc123',
        },
        retention: {
          min_days: 180,
        },
        integrity: {
          alg: 'sha256',
          content_sha256: '',
        },
      }

      const event2: EvidenceEvent = {
        integrity: {
          alg: 'sha256',
          content_sha256: '',
        },
        retention: {
          min_days: 180,
        },
        action: {
          name: 'test',
          args: {},
          proposed_sha256: 'abc123',
        },
        origin: {
          runId: 'run_abc',
          projectId: 'prj_789',
          plugin: 'mastra',
        },
        occurred_at: '2024-01-01T00:00:00.000Z',
        seq: 1,
        event_type: 'requested',
        approval_id: 'apr_456',
        event_id: 'evt_123',
        spec: 'hitly.evidence.v1',
      } as EvidenceEvent

      const hash1 = await hashEvidenceContent(event1)
      const hash2 = await hashEvidenceContent(event2)

      expect(hash1).toBe(hash2)
    })
  })
})
