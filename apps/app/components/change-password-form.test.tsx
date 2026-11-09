import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render tests for the signed-in change-password form. jsdom is registered
 * for this file only. fetch is replaced per test; the form runs the real
 * submitPasswordChange.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { ChangePasswordForm } from './change-password-form'
import {
  CHANGE_PASSWORD_SUCCEEDED_MESSAGE,
  CURRENT_PASSWORD_INCORRECT_MESSAGE,
} from '@/lib/password-change'
import { MIN_PASSWORD_LENGTH, PASSWORD_MISMATCH_MESSAGE } from '@/lib/password-reset'

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

function fillAndSubmit(current = 'old-password-1', next = 'new-password-2', confirm = next) {
  const [first, second, third] = passwordInputs()
  fireEvent.change(first!, { target: { value: current } })
  fireEvent.change(second!, { target: { value: next } })
  fireEvent.change(third!, { target: { value: confirm } })
  fireEvent.submit(first!.form!)
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('ChangePasswordForm', () => {
  it('renders the three password fields, pinning the shared minimum length', () => {
    render(<ChangePasswordForm />)
    const inputs = passwordInputs()
    assert.equal(inputs.length, 3)
    assert.equal(inputs[0]?.getAttribute('name'), 'currentPassword')
    assert.equal(inputs[1]?.getAttribute('minLength'), String(MIN_PASSWORD_LENGTH))
    assert.equal(inputs[2]?.getAttribute('minLength'), String(MIN_PASSWORD_LENGTH))
    assert.equal(screen.queryByRole('alert'), null)
  })

  it('asks for matching passwords before asking the server', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    render(<ChangePasswordForm />)
    fillAndSubmit('old-password-1', 'new-password-2', 'new-password-3')
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, PASSWORD_MISMATCH_MESSAGE))
    assert.equal(requests, 0, 'a mismatch never reaches the server')
  })

  it('shows the inline message when the current password is wrong', async () => {
    mockFetch(400, { code: 'INVALID_PASSWORD' })
    render(<ChangePasswordForm />)
    fillAndSubmit('wrong-password')
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, CURRENT_PASSWORD_INCORRECT_MESSAGE))
  })

  it('shows the shared policy message for a weak new password', async () => {
    mockFetch(400, { code: 'PASSWORD_TOO_SHORT' })
    render(<ChangePasswordForm />)
    fillAndSubmit('old-password-1', 'short')
    await waitFor(() =>
      assert.match(screen.getByRole('alert').textContent ?? '', new RegExp(String(MIN_PASSWORD_LENGTH))),
    )
  })

  it('shows the success state after a good submit', async () => {
    mockFetch(200, { ok: true })
    render(<ChangePasswordForm />)
    fillAndSubmit()
    const status = await screen.findByRole('status')
    assert.equal(status.textContent, CHANGE_PASSWORD_SUCCEEDED_MESSAGE)
    assert.equal(passwordInputs().length, 0)
  })
})
