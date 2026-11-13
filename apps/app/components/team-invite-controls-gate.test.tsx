import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResendInviteButton, WorkspaceInviteForm } from './team-invite-controls'
import type { GateBlockedResult } from '@/lib/verified-gate'
import { gateBlockedResult } from '@/lib/verified-gate'

/**
 * Render tests for the gated team invite controls (S3): a blocked invite
 * send or resend renders the shared "Verify your email to continue" state
 * (typed result), never a throw. Successful calls leave no blocked state.
 */

globalThis.FormData = window.FormData

afterEach(() => cleanup())

describe('WorkspaceInviteForm gate-blocked send', () => {
  it('renders the verify state when the invite send is blocked, without throwing', async () => {
    let calls = 0
    const received: FormData[] = []
    render(
      <WorkspaceInviteForm
        invite={async (formData) => {
          calls += 1
          received.push(formData)
          return gateBlockedResult()
        }}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('Invite email'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required'), 'blocked state renders'))
    assert.match(screen.getByTestId('verify-email-required').textContent ?? '', /Verify your email to continue/)
    assert.equal(calls, 1)
    assert.equal(received[0]?.get('email'), 'new@example.com')
    assert.equal(received[0]?.get('role'), 'member')
    assert.ok(screen.getByRole('button', { name: 'Invite' }), 'the form remains usable (no crash)')
  })

  it('a successful invite leaves no blocked state', async () => {
    render(<WorkspaceInviteForm invite={async () => undefined} />)
    fireEvent.change(screen.getByPlaceholderText('Invite email'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => assert.equal(screen.queryByTestId('verify-email-required'), null))
  })
})

describe('ResendInviteButton gate-blocked resend', () => {
  it('renders the verify state when the resend is blocked, without throwing', async () => {
    const seen: string[] = []
    render(
      <ResendInviteButton
        inviteId="inv_1"
        resend={async (inviteId): Promise<GateBlockedResult> => {
          seen.push(inviteId)
          return gateBlockedResult()
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }))
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required'), 'blocked state renders'))
    assert.match(screen.getByTestId('verify-email-required').textContent ?? '', /Verify your email to continue/)
    assert.deepEqual(seen, ['inv_1'])
  })

  it('a successful resend leaves no blocked state', async () => {
    render(<ResendInviteButton inviteId="inv_1" resend={async () => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Resend' }))
    await waitFor(() => assert.equal(screen.queryByTestId('verify-email-required'), null))
  })
})
