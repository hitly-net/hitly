import 'global-jsdom/register'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OriginalRequestPanel } from './original-request-panel'

/**
 * Copy path must hand navigator.clipboard.writeText the exact canonicalPayload
 * string from the route — no JSON.parse/stringify round-trip (kills M10).
 */

const CANONICAL = '{"a":{"b":[3,1,2],"y":"café"},"z":1}'

const realFetch = globalThis.fetch
let clipboardText: string | null = null

beforeEach(() => {
  clipboardText = null
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardText = text
      },
    },
  })
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        requestId: 'apr_1',
        canonicalPayload: CANONICAL,
        payloadSha256: 'deadbeef',
        argsSha256: 'cafebabe',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('OriginalRequestPanel', () => {
  it('renders the canonical payload verbatim and copies it without re-serialising', async () => {
    render(<OriginalRequestPanel approvalId="apr_1" />)
    fireEvent.click(screen.getByRole('button', { name: 'View original request' }))
    await waitFor(() => assert.ok(screen.getByText(CANONICAL, { exact: true })))
    const pre = document.querySelector('pre')
    assert.ok(pre)
    assert.equal(pre.textContent, CANONICAL)

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => assert.equal(clipboardText, CANONICAL))
    // Mutant guard: pretty-print or re-stringify would diverge.
    assert.notEqual(clipboardText, JSON.stringify(JSON.parse(CANONICAL), null, 2))
    assert.equal(clipboardText, CANONICAL)
  })
})
