import { test } from 'node:test'
import assert from 'node:assert'
import { buildChunkContextMarkdown } from './poller.js'

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

test('buildChunkContextMarkdown: includes rule name, binary, destination, and rationale', () => {
  const chunk = {
    id: '5ecbff46',
    status: 'pending' as const,
    rule_name: 'hitly_demo_smoke',
    binary: '/usr/bin/curl',
    proposed_rule: {
      protocol: 'rest',
      destination: 'example.invalid',
      port: 443,
    },
    rationale: 'HITLy demo: allow GET example.invalid/hitly-smoke',
    hit_count: 3,
    review_token: 'rt_test',
  }

  const md = buildChunkContextMarkdown(chunk, 'demo-sandbox', 'test-workspace')

  // Should include key fields in a human-readable format
  assert.ok(md.includes('hitly_demo_smoke'), 'should include rule name')
  assert.ok(md.includes('/usr/bin/curl'), 'should include binary path')
  assert.ok(md.includes('example.invalid:443'), 'should include destination')
  assert.ok(md.includes('HITLy demo: allow GET example.invalid/hitly-smoke'), 'should include rationale')
  assert.ok(md.includes('Observed requests:** 3'), 'should include hit count')
  
  // Should not start with a level-1 heading (was "# OpenShell Draft Policy Chunk")
  assert.ok(!md.startsWith('# '), 'should not start with H1')
  
  // Should start with the proposed rule section
  assert.ok(md.startsWith('## Proposed Network Policy Rule'), 'should start with H2')
  
  // Metadata should be in collapsible details
  assert.ok(md.includes('<details>'), 'should have collapsible metadata')
  assert.ok(md.includes('demo-sandbox'), 'should include sandbox in metadata')
  assert.ok(md.includes('test-workspace'), 'should include workspace in metadata')
})

test('buildChunkContextMarkdown: handles minimal chunk without optional fields', () => {
  const chunk = {
    id: 'minimal_chunk',
    status: 'pending' as const,
    review_token: 'rt_minimal',
  }

  const md = buildChunkContextMarkdown(chunk, 'test-sandbox', 'test-workspace')

  // Should still produce valid markdown
  assert.ok(md.includes('## Proposed Network Policy Rule'), 'should have heading')
  assert.ok(md.includes('minimal_chunk'), 'should include chunk ID in metadata')
  assert.ok(!md.includes('undefined'), 'should not include undefined text')
})

test('buildChunkContextMarkdown: formats security notes', () => {
  const chunk = {
    id: 'secure_chunk',
    status: 'pending' as const,
    security_notes: [
      'External API access requires authentication',
      'Review credential handling',
    ],
    review_token: 'rt_secure',
  }

  const md = buildChunkContextMarkdown(chunk, 'test-sandbox', 'test-workspace')

  assert.ok(md.includes('⚠️ Security Notes'), 'should have security notes section')
  assert.ok(md.includes('External API access requires authentication'), 'should include first note')
  assert.ok(md.includes('Review credential handling'), 'should include second note')
})

test('buildChunkContextMarkdown: handles modern endpoints array format', () => {
  const chunk = {
    id: 'modern_chunk',
    status: 'pending' as const,
    rule_name: 'api_access',
    proposed_rule: {
      protocol: 'rest',
      endpoints: [
        {
          host: 'api.example.com',
          ports: [443, 8443],
        },
      ],
    },
    review_token: 'rt_modern',
  }

  const md = buildChunkContextMarkdown(chunk, 'test-sandbox', 'test-workspace')

  assert.ok(md.includes('api.example.com:443,8443'), 'should format multiple ports')
})

test('buildChunkContextMarkdown: shows L7 protocols as URL-like destinations', () => {
  const chunk = {
    id: 'l7_chunk',
    status: 'pending' as const,
    proposed_rule: {
      protocol: 'rest',
      destination: 'api.github.com',
      port: 443,
    },
    review_token: 'rt_l7',
  }

  const md = buildChunkContextMarkdown(chunk, 'test-sandbox', 'test-workspace')

  assert.ok(md.includes('https://api.github.com:443'), 'should format REST as https://')
})

test('buildChunkContextMarkdown: shows L4 protocols with protocol label', () => {
  const chunk = {
    id: 'l4_chunk',
    status: 'pending' as const,
    proposed_rule: {
      protocol: 'tcp',
      destination: 'db.example.com',
      port: 5432,
    },
    review_token: 'rt_l4',
  }

  const md = buildChunkContextMarkdown(chunk, 'test-sandbox', 'test-workspace')

  assert.ok(md.includes('db.example.com:5432'), 'should include destination')
  assert.ok(md.includes('(tcp)'), 'should include protocol label')
})
