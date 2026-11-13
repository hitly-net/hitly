import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectResumeSecret } from './project-resume-secret'
import type { GateBlockedResult } from '@/lib/verified-gate'
import { gateBlockedResult } from '@/lib/verified-gate'

/**
 * Render test (S12 exception, S13 UI): a gate-blocked resume-secret
 * regenerate renders the shared "Verify your email to continue" state with
 * the resend link — never a raw object render, 500 or error id — and a
 * success rotates the displayed secret with no blocked state left behind.
 */

afterEach(() => cleanup())

function autoConfirm() {
  const confirm = () => true
  window.confirm = confirm
  ;(globalThis as unknown as { confirm?: unknown }).confirm = confirm
}

function clickRegenerate() {
  const button = screen.getByRole('button', { name: /Regenerate/i })
  fireEvent.click(button)
}

describe('ProjectResumeSecret gate-blocked regenerate', () => {
  it('renders the verify state (not a raw result / throw) when the regenerate is gate-blocked', async () => {
    let calls = 0
    const regenerate = async (): Promise<GateBlockedResult> => {
      calls += 1
      return gateBlockedResult()
    }
    autoConfirm()
    const { container } = render(
      <ProjectResumeSecret projectId="prj_x" secret={'rs_'.padEnd(32, 'a')} regenerate={regenerate} />,
    )
    clickRegenerate()
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required'), 'blocked state renders'))
    const box = screen.getByTestId('verify-email-required')
    assert.match(box.textContent ?? '', /Verify your email to continue/)
    assert.match(box.textContent ?? '', /Resend verification email/, 'resend link is offered')
    assert.equal(box.getAttribute('role'), 'status')
    assert.equal(calls, 1, 'the action completed normally (returned, did not throw)')
    // The blocked object must never leak into the visible secret area.
    assert.ok(!container.textContent?.includes('email_not_verified'), 'no raw error id rendered')
    assert.ok(container.querySelector('button'), 'still interactive after the refusal')
  })

  it('a successful regenerate updates the secret and leaves no blocked state', async () => {
    const regenerate = async (): Promise<string> => 'rs_rotated_new_value_0123456789ab'
    autoConfirm()
    render(<ProjectResumeSecret projectId="prj_x" secret={'rs_'.padEnd(32, 'a')} regenerate={regenerate} />)
    clickRegenerate()
    await waitFor(() => assert.ok(screen.queryByText(/previous secret no longer works/i)))
    assert.equal(screen.queryByTestId('verify-email-required'), null)
  })

  it('window.confirm cancel does not call the action at all', async () => {
    let calls = 0
    const regenerate = async (): Promise<string> => {
      calls += 1
      return 'rs_x'
    }
    const originalConfirm = window.confirm
    window.confirm = () => false
    ;(globalThis as unknown as { confirm?: unknown }).confirm = () => false
    try {
      render(<ProjectResumeSecret projectId="prj_x" secret={'rs_'.padEnd(32, 'a')} regenerate={regenerate} />)
      clickRegenerate()
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal(calls, 0)
    } finally {
      window.confirm = originalConfirm
      delete (globalThis as unknown as { confirm?: unknown }).confirm
    }
  })
})
