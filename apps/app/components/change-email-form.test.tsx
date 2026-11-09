import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render tests for the signed-in change-email form. jsdom is registered
 * for this file only. fetch is replaced per test; the form runs the real
 * submitEmailChange.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { ChangeEmailForm } from './change-email-form'
import {
  CHANGE_EMAIL_SUCCEEDED_MESSAGE,
  CURRENT_PASSWORD_INCORRECT_MESSAGE,
  INVALID_EMAIL_MESSAGE,
} from '@/lib/email-change'

const realFetch = globalThis.fetch

globalThis.FormData = window.FormData

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

function fillAndSubmit(email = 'new@example.com', password = 'old-password-1') {
  const emailInput = document.querySelector('input[name="newEmail"]') as HTMLInputElement
  const passwordInput = document.querySelector('input[name="currentPassword"]') as HTMLInputElement
  fireEvent.change(emailInput, { target: { value: email } })
  fireEvent.change(passwordInput, { target: { value: password } })
  fireEvent.submit(emailInput.form!)
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('ChangeEmailForm', () => {
  it('renders the new email and current password fields', () => {
    render(<ChangeEmailForm />)
    assert.equal(document.querySelector('input[name="newEmail"]')?.getAttribute('type'), 'email')
    assert.equal(document.querySelector('input[name="currentPassword"]')?.getAttribute('type'), 'password')
    assert.equal(screen.queryByRole('alert'), null)
  })

  it('shows the inline message when the current password is wrong', async () => {
    mockFetch(400, { code: 'INVALID_PASSWORD' })
    render(<ChangeEmailForm />)
    fillAndSubmit('new@example.com', 'wrong-password')
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, CURRENT_PASSWORD_INCORRECT_MESSAGE))
  })

  it('shows the shared invalid-email message', async () => {
    mockFetch(400, { code: 'INVALID_EMAIL' })
    render(<ChangeEmailForm />)
    fillAndSubmit('not-an-email')
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, INVALID_EMAIL_MESSAGE))
  })

  it('shows the success state after a good submit', async () => {
    mockFetch(200, { ok: true })
    render(<ChangeEmailForm />)
    fillAndSubmit()
    const status = await screen.findByRole('status')
    assert.equal(status.textContent, CHANGE_EMAIL_SUCCEEDED_MESSAGE)
    assert.equal(document.querySelectorAll('input').length, 0)
  })
})
