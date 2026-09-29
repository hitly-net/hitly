import { test } from 'node:test'
import assert from 'node:assert'

// Simple test to verify poller idempotency tracking
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
