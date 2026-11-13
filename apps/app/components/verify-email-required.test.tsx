import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VerifyEmailRequiredNotice } from './verify-email-required'
import {
  RESEND_EMAIL_VERIFICATION_ENDPOINT,
  RESEND_VERIFICATION_SUCCEEDED_MESSAGE,
  RESEND_VERIFICATION_THROTTLED_MESSAGE,
} from '@/lib/email-verification'

/**
 * Render tests for the shared "Verify your email to continue" state shown in
 * place of a gate-blocked create (S1/S2/S3): it must name the fix, offer the
 * rate-limited resend link, and never look like a crash (it renders as a
 * status region, no stack, no error id).
 */

const realFetch = globalThis.fetch

globalThis.FormData = window.FormData

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('VerifyEmailRequiredNotice', () => {
  it('shows the agreed headline and a resend affordance without POSTing', () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    render(<VerifyEmailRequiredNotice />)
    const box = screen.getByTestId('verify-email-required')
    assert.match(box.textContent ?? '', /Verify your email to continue/)
    assert.match(box.textContent ?? '', /Verify your email address/i)
    assert.equal(box.getAttribute('role'), 'status')
    assert.equal(screen.getByRole('button').textContent, 'Resend verification email')
    assert.equal(requests, 0, 'rendering never POSTs on its own')
  })

  it('the resend button uses the same rate-limited signed-in endpoint and shows generic success', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    render(<VerifyEmailRequiredNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }))
    await waitFor(() => assert.equal(calls.length, 1))
    assert.match(calls[0], new RegExp(RESEND_EMAIL_VERIFICATION_ENDPOINT))
    await screen.findByText(RESEND_VERIFICATION_SUCCEEDED_MESSAGE)
  })

  it('a throttled resend surfaces the generic throttle copy, not a crash', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 429 })) as typeof fetch
    render(<VerifyEmailRequiredNotice />)
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }))
    await waitFor(() => assert.ok(screen.queryByRole('alert'), 'throttle message surfaces'))
    assert.equal(screen.getByRole('alert').textContent, RESEND_VERIFICATION_THROTTLED_MESSAGE)
  })

  it('renders a caller-provided message under the same headline', () => {
    render(<VerifyEmailRequiredNotice message="Custom instruction." />)
    const box = screen.getByTestId('verify-email-required')
    assert.match(box.textContent ?? '', /Verify your email to continue/)
    assert.match(box.textContent ?? '', /Custom instruction\./)
  })
})
