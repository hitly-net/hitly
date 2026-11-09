import 'global-jsdom/register'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkPresentedIfCanAct } from './work-item-client'

/**
 * S97-S3: web `{canAct ? <MarkPresented/> : null}` must not POST when the
 * reviewer cannot act. The server still gates; this pins the UI trigger.
 */

const realFetch = globalThis.fetch
const realConsoleWarn = console.warn
let fetchCalls: Array<{ url: string; method?: string }> = []

beforeEach(() => {
  fetchCalls = []
  console.warn = () => undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    fetchCalls.push({ url, method: init?.method })
    return new Response(JSON.stringify({ id: 'apr_1', presentedAt: '2026-11-09T00:00:00.000Z' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  console.warn = realConsoleWarn
})

describe('MarkPresentedIfCanAct', () => {
  it('does not POST /presented when canAct is false', async () => {
    render(<MarkPresentedIfCanAct canAct={false} approvalId="apr_1" />)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(fetchCalls.length, 0, 'readers / closed items must not fire MarkPresented')
  })

  it('POSTs /presented once when canAct is true', async () => {
    render(<MarkPresentedIfCanAct canAct={true} approvalId="apr_1" />)
    await waitFor(() => assert.equal(fetchCalls.length, 1))
    assert.equal(fetchCalls[0]?.method, 'POST')
    assert.equal(fetchCalls[0]?.url, '/api/v1/approvals/apr_1/presented')
  })
})
