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
import { RESET_LINK_INVALID_MESSAGE, RESET_PASSWORD_FAILED_MESSAGE } from '@/lib/password-reset'

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
    render(<ResetPasswordForm token="checked-token" />)
    assert.equal(passwordInputs().length, 2)
    assert.equal(screen.queryByRole('alert'), null)
    assert.equal(requestLink(), null)
  })

  it('shows the error and a request link, and no form, when there is no usable token', () => {
    render(<ResetPasswordForm token={null} />)
    assert.equal(passwordInputs().length, 0)
    assert.equal(screen.getByRole('alert').textContent, RESET_LINK_INVALID_MESSAGE)
    assert.equal(requestLink()?.getAttribute('href'), '/forgot-password')
  })

  it('after a rejected token on submit, shows the error with a request link and clears the fields', async () => {
    mockFetch(400, { code: 'INVALID_TOKEN', message: 'Invalid token' })
    render(<ResetPasswordForm token="checked-token" />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, RESET_LINK_INVALID_MESSAGE)
    assert.equal(requestLink()?.getAttribute('href'), '/forgot-password')
    await waitFor(() => assert.deepEqual(passwordInputs().map((i) => i.value), ['', '']))
  })

  it('offers a new link after an unexpected server failure too', async () => {
    mockFetch(500, {})
    render(<ResetPasswordForm token="checked-token" />)
    fillAndSubmit()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, RESET_PASSWORD_FAILED_MESSAGE)
    assert.ok(requestLink())
    assert.deepEqual(passwordInputs().map((i) => i.value), ['', ''])
  })

  it('does not offer a new link for a password the server finds too short', async () => {
    mockFetch(400, { code: 'PASSWORD_TOO_SHORT' })
    render(<ResetPasswordForm token="checked-token" />)
    fillAndSubmit()
    await screen.findByRole('alert')
    assert.equal(requestLink(), null)
  })

  it('shows the success state after a good submit', async () => {
    mockFetch(200, { status: true })
    render(<ResetPasswordForm token="checked-token" />)
    fillAndSubmit()
    await screen.findByRole('status')
    assert.equal(passwordInputs().length, 0)
  })
})
