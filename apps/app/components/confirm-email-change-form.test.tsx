import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render tests for the email-change confirm button. jsdom is registered
 * for this file only. fetch is replaced per test; the form runs the real
 * submitEmailChangeVerification.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { ConfirmEmailChangeForm } from './confirm-email-change-form'
import {
  EMAIL_CHANGED_MESSAGE,
  VERIFY_EMAIL_CHANGE_ENDPOINT,
  VERIFY_EMAIL_CHANGE_INVALID_MESSAGE,
} from '@/lib/email-change'

const realFetch = globalThis.fetch

globalThis.FormData = window.FormData

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('ConfirmEmailChangeForm', () => {
  it('renders a Confirm button and does not POST until it is pressed', () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    render(<ConfirmEmailChangeForm token={'A'.repeat(43)} />)
    assert.equal(screen.getByRole('button').textContent, 'Confirm')
    assert.equal(requests, 0)
  })

  it('POSTs the token as JSON to the verify route', async () => {
    const calls: { url: string; method: string; body: string }[] = []
    globalThis.fetch = (async (input, init) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        body: String(init?.body ?? ''),
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const token = 'B'.repeat(43)
    render(<ConfirmEmailChangeForm token={token} />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    const status = await screen.findByRole('status')
    assert.equal(status.textContent, EMAIL_CHANGED_MESSAGE)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, VERIFY_EMAIL_CHANGE_ENDPOINT)
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.body, JSON.stringify({ token }))
  })

  it('shows the generic invalid-link message when the POST is refused', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    render(<ConfirmEmailChangeForm token={'C'.repeat(43)} />)
    fireEvent.submit(screen.getByRole('button').closest('form')!)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, VERIFY_EMAIL_CHANGE_INVALID_MESSAGE))
  })
})
