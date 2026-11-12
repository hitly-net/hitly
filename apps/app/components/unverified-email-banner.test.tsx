import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UnverifiedEmailBanner } from './unverified-email-banner'
import {
  RESEND_EMAIL_VERIFICATION_ENDPOINT,
  RESEND_VERIFICATION_SUCCEEDED_MESSAGE,
  RESEND_VERIFICATION_THROTTLED_MESSAGE,
} from '@/lib/email-verification'

/**
 * Render tests for the top-of-app unverified-email banner (the gated-GA
 * companion of the settings notice). jsdom is registered for this file only.
 */

const realFetch = globalThis.fetch

globalThis.FormData = window.FormData

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('UnverifiedEmailBanner', () => {
  it('names what the gate holds and shows the resend affordance without POSTing', () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    render(<UnverifiedEmailBanner />)
    assert.match(screen.getByTestId('unverified-email-banner').textContent ?? '', /Email not verified/)
    assert.match(screen.getByTestId('unverified-email-banner').textContent ?? '', /create projects and API keys/)
    assert.match(screen.getByTestId('unverified-email-banner').textContent ?? '', /notifications/)
    assert.equal(screen.getByRole('button').textContent, 'Resend verification email')
    assert.equal(requests, 0)
  })

  it('resends through the shared rate-limited endpoint and shows the generic success copy', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        body: String(init?.body ?? ''),
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    render(<UnverifiedEmailBanner />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    await screen.findByText(RESEND_VERIFICATION_SUCCEEDED_MESSAGE)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, RESEND_EMAIL_VERIFICATION_ENDPOINT)
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.body, '{}')
  })

  it('shows the throttled copy (never an address) when resend is rate-limited', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch
    render(<UnverifiedEmailBanner />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, RESEND_VERIFICATION_THROTTLED_MESSAGE))
    assert.ok(!screen.getByRole('alert').textContent?.includes('@'))
  })
})
