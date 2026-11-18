import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHitlyClient } from './hitly-client'

/**
 * Mobile surface of the retention cap: the retry-resume refusal (402 +
 * stable code + human message) must surface to the reviewer through the
 * client's error path, so the retry button shows WHY it was refused.
 */
test('retryResume 402 tier refusal surfaces the human message', async () => {
  const mockFetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/retry-resume')) {
      return {
        ok: false,
        status: 402,
        json: async () => ({
          error: "This item is 12 days old — past your plan's 10-day retention for completed items. Upgrade to extend retention.",
          code: 'tier_limit_reached',
        }),
      } as Response
    }
    throw new Error('Unexpected URL')
  }
  globalThis.fetch = mockFetch as typeof fetch

  const client = createHitlyClient({ baseUrl: 'http://localhost:3001', token: 'test-token' })
  await assert.rejects(
    async () => {
      await client.retryResume('apr_123')
    },
    { message: /past your plan's 10-day retention/ },
  )
})
