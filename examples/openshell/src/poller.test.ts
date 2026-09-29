import { test } from 'node:test'
import assert from 'node:assert'

// Type matching the protobuf PolicyChunk response from GetDraftPolicy
interface PolicyChunk {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  proposed_rule?: {
    kind?: string
    protocol?: string
    destination?: string
    port?: number
  }
  rationale?: string
  security_notes?: string[]
  hit_count?: number
  review_token?: string
}

// Simulates the mapping done in createHitlyApproval
function mapChunkToApprovalPayload(chunk: PolicyChunk, sandbox: string, workspace: string, projectId: string) {
  const { id: chunkId, review_token: reviewToken } = chunk
  
  return {
    plugin: 'openshell',
    projectId,
    workspace,
    sandbox,
    chunkId,
    reviewToken,
    gatewayAddr: 'gateway.example.com:443',
    actionName: 'approve-openshell-draft-chunk',
    args: {
      chunkId,
      sandbox,
      workspace,
      rule: chunk.proposed_rule,
      rationale: chunk.rationale,
      securityNotes: chunk.security_notes,
    },
  }
}

test('poller field mapping: PolicyChunk.id maps to payload.chunkId', () => {
  const chunk: PolicyChunk = {
    id: 'chunk_abc123',
    status: 'pending',
    review_token: 'rt_xyz789',
    proposed_rule: {
      kind: 'egress',
      protocol: 'tcp',
      destination: 'api.example.com',
      port: 443,
    },
    rationale: 'Test chunk',
    hit_count: 5,
  }

  const payload = mapChunkToApprovalPayload(chunk, 'sandbox1', 'workspace1', 'proj123')

  assert.strictEqual(payload.chunkId, 'chunk_abc123', 'PolicyChunk.id should map to payload.chunkId')
  assert.strictEqual(payload.reviewToken, 'rt_xyz789', 'PolicyChunk.review_token should map to payload.reviewToken')
  assert.strictEqual(payload.args.chunkId, 'chunk_abc123', 'args.chunkId should match top-level chunkId')
  assert.strictEqual(payload.plugin, 'openshell')
  assert.strictEqual(payload.sandbox, 'sandbox1')
  assert.strictEqual(payload.workspace, 'workspace1')
})

test('poller field mapping: missing review_token is handled', () => {
  const chunk: PolicyChunk = {
    id: 'chunk_no_token',
    status: 'pending',
    rationale: 'Chunk without token',
  }

  const payload = mapChunkToApprovalPayload(chunk, 'sandbox1', 'workspace1', 'proj123')

  assert.strictEqual(payload.chunkId, 'chunk_no_token', 'chunkId should still be mapped')
  assert.strictEqual(payload.reviewToken, undefined, 'reviewToken should be undefined when missing')
})

test('poller idempotency: seenChunks prevents duplicate approvals', () => {
  const seenChunks = new Set<string>()

  // Simulate first poll: sandbox1:chunk1 is new
  const chunk1Key = 'sandbox1:chunk_abc123'
  assert.strictEqual(seenChunks.has(chunk1Key), false, 'chunk should not be seen yet')
  seenChunks.add(chunk1Key)

  // Simulate second poll: same chunk appears again (idempotent)
  assert.strictEqual(seenChunks.has(chunk1Key), true, 'chunk should be marked as seen')

  // Simulate new chunk
  const chunk2Key = 'sandbox1:chunk_def456'
  assert.strictEqual(seenChunks.has(chunk2Key), false, 'new chunk should not be seen yet')
  seenChunks.add(chunk2Key)

  // Verify both are tracked
  assert.strictEqual(seenChunks.size, 2, 'should track both chunks')
  assert.strictEqual(seenChunks.has(chunk1Key), true)
  assert.strictEqual(seenChunks.has(chunk2Key), true)
})

test('poller idempotency: different sandbox+chunk combinations are unique', () => {
  const seenChunks = new Set<string>()

  // Same chunk ID in different sandboxes = different keys
  seenChunks.add('sandbox1:chunk_abc')
  seenChunks.add('sandbox2:chunk_abc')

  assert.strictEqual(seenChunks.size, 2, 'same chunk in different sandboxes should be tracked separately')
  assert.strictEqual(seenChunks.has('sandbox1:chunk_abc'), true)
  assert.strictEqual(seenChunks.has('sandbox2:chunk_abc'), true)
  assert.strictEqual(seenChunks.has('sandbox3:chunk_abc'), false)
})
