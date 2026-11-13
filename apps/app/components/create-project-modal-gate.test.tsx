import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CreateProjectModal } from './create-project-modal'
import type { GateBlockedResult } from '@/lib/verified-gate'
import { gateBlockedResult } from '@/lib/verified-gate'

/**
 * Render test for the gated project create (S1): when the server action
 * returns the typed blocked result, the modal renders the "Verify your email
 * to continue" state with the resend link — not a throw, not a 500, not a
 * raw error id. Success (which redirects server-side) must not leave a
 * blocked state behind.
 */

globalThis.FormData = window.FormData

afterEach(() => cleanup())

function submit() {
  const form = document.querySelector('form')
  assert.ok(form, 'the create form is rendered')
  fireEvent.submit(form)
}

describe('CreateProjectModal gate-blocked create', () => {
  it('renders the verify state (not a throw/500) when the create is gate-blocked', async () => {
    let calls = 0
    let received: FormData | null = null
    const create = async (formData: FormData): Promise<GateBlockedResult> => {
      calls += 1
      received = formData
      return gateBlockedResult()
    }
    render(<CreateProjectModal create={create} />)
    const nameInput = screen.getByPlaceholderText('Refunds')
    fireEvent.change(nameInput, { target: { value: 'Refunds' } })
    submit()
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required'), 'blocked state renders'))
    const box = screen.getByTestId('verify-email-required')
    assert.match(box.textContent ?? '', /Verify your email to continue/)
    assert.equal(box.getAttribute('role'), 'status', 'a status region, not an error page')
    // The dialog is closed in jsdom (content hidden from the a11y tree), so
    // the resend link is asserted inside the notice subtree by text.
    assert.match(box.textContent ?? '', /Resend verification email/, 'resend link is offered')
    assert.equal(calls, 1, 'the action completed normally (returned, did not throw)')
    assert.equal((received as unknown as FormData | null)?.get('name'), 'Refunds')
    // The dialog and form are still interactive: nothing crashed.
    assert.ok(document.querySelector('form'), 'form still mounted after the refusal')
  })

  it('a successful create (redirect happens server-side) leaves no blocked state', async () => {
    const create = async (): Promise<void> => undefined
    render(<CreateProjectModal create={create} />)
    submit()
    await waitFor(() => assert.ok(document.querySelector('form')))
    assert.equal(screen.queryByTestId('verify-email-required'), null)
  })
})
