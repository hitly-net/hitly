import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render tests for the reset-password form. jsdom is registered for this file
 * only. fetch is replaced per test; the form runs the real submitNewPassword.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { ResetPasswordForm } from './reset-password-form'
import {
  PASSWORD_MISMATCH_MESSAGE,
  RESET_LINK_CHECK_UNAVAILABLE_MESSAGE,
  RESET_LINK_INVALID_MESSAGE,
  RESET_PASSWORD_FAILED_MESSAGE,
  RESET_PASSWORD_RETRY_MESSAGE,
  RESET_REQUEST_NETWORK_MESSAGE,
} from '@/lib/password-reset'
import type { ResetPageState } from '@/lib/reset-token-check'

const FORM: ResetPageState = { kind: 'form', token: 'checked-token' }

const realFetch = globalThis.fetch

// Use the jsdom FormData so the form can be read from a jsdom <form>.
globalThis.FormData = window.FormData

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

function passwordInputs() {
  return Array.from(document.querySelectorAll('input[type="password"]')) as HTMLInputElement[]
}

function requestLink() {
  return screen.queryByRole('link', { name: 'Request a new link' }) as HTMLAnchorElement | null
}

function fillAndSubmit(password = 'new-password-2') {
  const [first, second] = passwordInputs()
  fireEvent.change(first!, { target: { value: password } })
  fireEvent.change(second!, { target: { value: password } })
  fireEvent.submit(first!.form!)
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('ResetPasswordForm', () => {
  it('shows the form for a checked token, with no error or request link', () => {
    render(<ResetPasswordForm state={FORM} />)
    assert.equal(passwordInputs().length, 2)
    assert.equal(screen.queryByRole('alert'), null)
    assert.equal(requestLink(), null)
  })

  it('shows the error and a request link, and no form, when there is no usable token', () => {
    render(<ResetPasswordForm state={{ kind: 'invalid' }} />)
    assert.equal(passwordInputs().length, 0)
    assert.equal(screen.getByRole('alert').textContent, RESET_LINK_INVALID_MESSAGE)
    assert.equal(requestLink()?.getAttribute('href'), '/forgot-password')
  })

  it('after a rejected token on submit, shows the error with a request link and clears the fields', async () => {
    mockFetch(400, { code: 'INVALID_TOKEN', message: 'Invalid token' })
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, RESET_LINK_INVALID_MESSAGE)
    assert.equal(requestLink()?.getAttribute('href'), '/forgot-password')
    await waitFor(() => assert.deepEqual(passwordInputs().map((i) => i.value), ['', '']))
  })

  it('asks the user to try again, without a request link, after a server error', async () => {
    mockFetch(500, {})
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, RESET_PASSWORD_RETRY_MESSAGE)
    assert.equal(requestLink(), null)
    assert.equal(passwordInputs().length, 2)
  })

  it('offers a new link when the server refuses the request for another reason', async () => {
    mockFetch(400, { code: 'SOMETHING_ELSE' })
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, RESET_PASSWORD_FAILED_MESSAGE)
    assert.ok(requestLink())
    assert.deepEqual(passwordInputs().map((i) => i.value), ['', ''])
  })

  it('does not offer a new link for a password the server finds too long', async () => {
    mockFetch(400, { code: 'PASSWORD_TOO_LONG' })
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    await screen.findByRole('alert')
    assert.equal(requestLink(), null)
  })

  it('does not offer a new link after a network error', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, RESET_REQUEST_NETWORK_MESSAGE)
    assert.equal(requestLink(), null)
  })

  it('clears the request link when a later attempt has mismatched passwords', async () => {
    mockFetch(400, { code: 'INVALID_TOKEN' })
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    await screen.findByRole('alert')
    assert.ok(requestLink())
    const [first, second] = passwordInputs()
    fireEvent.change(first!, { target: { value: 'new-password-2' } })
    fireEvent.change(second!, { target: { value: 'new-password-3' } })
    fireEvent.submit(first!.form!)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, PASSWORD_MISMATCH_MESSAGE))
    assert.equal(requestLink(), null)
  })

  it('shows the try-again state, with no form, when the link could not be checked', () => {
    let retries = 0
    render(<ResetPasswordForm state={{ kind: 'unavailable' }} onRetry={() => (retries += 1)} />)
    assert.equal(passwordInputs().length, 0)
    assert.equal(screen.getByRole('alert').textContent, RESET_LINK_CHECK_UNAVAILABLE_MESSAGE)
    assert.equal(requestLink()?.getAttribute('href'), '/forgot-password')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    assert.equal(retries, 1)
  })

  it('does not offer a new link for a password the server finds too short', async () => {
    mockFetch(400, { code: 'PASSWORD_TOO_SHORT' })
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    await screen.findByRole('alert')
    assert.equal(requestLink(), null)
  })

  it('shows the success state after a good submit', async () => {
    mockFetch(200, { status: true })
    render(<ResetPasswordForm state={FORM} />)
    fillAndSubmit()
    await screen.findByRole('status')
    assert.equal(passwordInputs().length, 0)
  })
})
