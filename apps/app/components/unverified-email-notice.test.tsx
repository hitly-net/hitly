import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UnverifiedEmailNotice } from './unverified-email-notice'
import {
  RESEND_EMAIL_VERIFICATION_ENDPOINT,
  RESEND_VERIFICATION_SUCCEEDED_MESSAGE,
  RESEND_VERIFICATION_THROTTLED_MESSAGE,
  RESEND_VERIFICATION_UNAUTHENTICATED_MESSAGE,
} from '@/lib/email-verification'

/**
 * Render tests for the settings unverified notice. jsdom is registered for
 * this file only.
 */

const realFetch = globalThis.fetch

globalThis.FormData = window.FormData

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('UnverifiedEmailNotice', () => {
  it('renders nothing once the address is verified', () => {
    const { container } = render(<UnverifiedEmailNotice verified />)
    assert.equal(container.textContent, '')
  })

  it('shows the unverified badge and does not POST until resend is pressed', () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    render(<UnverifiedEmailNotice verified={false} />)
    assert.match(screen.getByText('Unverified').textContent ?? '', /Unverified/)
    assert.equal(screen.getByRole('button').textContent, 'Resend verification email')
    assert.equal(requests, 0)
  })

  it('POSTs an empty JSON body and shows the generic success copy', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        body: String(init?.body ?? ''),
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    render(<UnverifiedEmailNotice verified={false} />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    const status = await screen.findByRole('status')
    assert.equal(status.textContent, RESEND_VERIFICATION_SUCCEEDED_MESSAGE)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, RESEND_EMAIL_VERIFICATION_ENDPOINT)
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.body, '{}')
  })

  it('maps 429 and 401 onto fixed messages that do not mention an address', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch
    const { unmount } = render(<UnverifiedEmailNotice verified={false} />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, RESEND_VERIFICATION_THROTTLED_MESSAGE))
    assert.ok(!screen.getByRole('alert').textContent?.includes('@'))
    unmount()

    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch
    render(<UnverifiedEmailNotice verified={false} />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    await waitFor(() =>
      assert.equal(screen.getByRole('alert').textContent, RESEND_VERIFICATION_UNAUTHENTICATED_MESSAGE),
    )
  })
})
