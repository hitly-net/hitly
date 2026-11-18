import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './test-helpers.ts'
import type { HostClient } from './host-client.ts'

/**
 * MCP surface of the decision cap: a host tier refusal (402 + stable code)
 * must reach the bot as its own machine-readable code with the host's human
 * message — not flattened to 'invalid_request'.
 */

function tierHost(): HostClient {
  const unused = async () =>
    ({ ok: false as const, status: 501, error: 'unused', code: 'not_supported_by_host' as const })
  return {
    ingest: async () => ({
      ok: false as const,
      status: 402,
      error: 'Monthly decision limit reached (300 of 300 decisions used this month). Upgrade to allow more decisions per month.',
      code: 'tier_limit_reached' as const,
    }),
    getApproval: unused,
    listPending: unused,
    cancel: unused,
  }
}

const baseApproval = {
  idempotencyKey: 'bot-tier-0001',
  question: 'Send refund?',
  action: { name: 'refunds.send', args: { amount: 10 } },
}

describe('MCP request_approval tier refusal', () => {
  it('surfaces the stable tier_limit_reached code and the host message', async () => {
    const h = await startHarness({ deps: { hostFor: () => tierHost() } })
    try {
      const client = await h.client()
      const result = (await client.callTool({
        name: 'request_approval',
        arguments: baseApproval,
      })) as unknown as { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> }
      const text = JSON.stringify(result.structuredContent ?? result.content)
      assert.match(text, /tier_limit_reached/, 'the stable code reaches the bot')
      assert.match(text, /Monthly decision limit reached/, "the host's human message reaches the bot")
    } finally {
      await h.close()
    }
  })
})
