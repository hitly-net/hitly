import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TierUsageMeter } from './tier-usage-meter'
import { TierLimitNotice } from './tier-limit-notice'
import { WorkspaceInviteForm } from './team-invite-controls'
import { CreateProjectModal } from './create-project-modal'
import type { TierLimitBlockedResult, TierUsage } from '@/lib/tier-enforcement'

/**
 * Render tests for the tier limit/usage display and upgrade path:
 * the meter shows current limit/usage where the action lives and an upgrade
 * path (Free/Pro /signup billing, Team/Enterprise contact, self-hosted none);
 * the refusal notice renders from the typed action result without throwing.
 */

globalThis.FormData = window.FormData
// jsdom ships <dialog> closed (display:none) and without showModal(): teach
// it just enough for the modal flow to open.
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
}

afterEach(() => cleanup())

const seatsAtCap: TierUsage = {
  limitKey: 'seats',
  usage: 2,
  limit: 2,
  reached: true,
  upgrade: { label: 'Upgrade', href: '/signup' },
}
const underCap: TierUsage = {
  limitKey: 'live_projects',
  usage: 1,
  limit: 10,
  reached: false,
  upgrade: { label: 'Upgrade', href: '/signup' },
}
const unlimited: TierUsage = {
  limitKey: 'seats',
  usage: 40,
  limit: null,
  reached: false,
  upgrade: null,
}
const denied: TierUsage = {
  limitKey: 'seats',
  usage: 0,
  limit: null,
  reached: true,
  upgrade: { label: 'Contact us', href: 'mailto:hello@hitly.net' },
}

describe('TierUsageMeter', () => {
  it('shows current limit and usage', () => {
    render(<TierUsageMeter title="Live projects" usage={underCap} />)
    assert.match(screen.getByTestId('tier-usage-meter').textContent ?? '', /Live projects: 1 of 10 used/)
    assert.equal(screen.queryByTestId('tier-usage-upgrade'), null, 'no upgrade prompt under the cap')
  })

  it('at the cap it shows the full numbers and the Free/Pro upgrade path to /signup', () => {
    render(<TierUsageMeter title="Seats" usage={seatsAtCap} />)
    const node = screen.getByTestId('tier-usage-meter')
    assert.match(node.textContent ?? '', /Seats: 2 of 2 used/)
    const link = screen.getByTestId('tier-usage-upgrade')
    assert.equal(link.getAttribute('href'), '/signup')
    assert.equal(link.textContent, 'Upgrade')
  })

  it('Team/Enterprise surface the contact path', () => {
    render(<TierUsageMeter title="Seats" usage={denied} />)
    const link = screen.getByTestId('tier-usage-upgrade')
    assert.equal(link.getAttribute('href'), 'mailto:hello@hitly.net')
    assert.equal(link.textContent, 'Contact us')
  })

  it('unlimited plans show no limit and no upgrade link', () => {
    render(<TierUsageMeter title="Seats" usage={unlimited} />)
    assert.match(screen.getByTestId('tier-usage-meter').textContent ?? '', /unlimited on your plan/)
    assert.equal(screen.queryByTestId('tier-usage-upgrade'), null)
  })
})

describe('TierLimitNotice', () => {
  it('renders the refusal message and upgrade link', () => {
    const result: TierLimitBlockedResult = {
      status: 'error',
      code: 'tier_limit_reached',
      limitKey: 'seats',
      message: 'Seat limit reached (2 of 2 seats in use, counting members and pending invites). Remove a person or upgrade to add more.',
    }
    render(<TierLimitNotice result={result} upgrade={{ label: 'Upgrade', href: '/signup' }} />)
    const node = screen.getByTestId('tier-limit-notice')
    assert.match(node.textContent ?? '', /Seat limit reached \(2 of 2 seats in use/)
    assert.equal(screen.getByTestId('tier-limit-upgrade').getAttribute('href'), '/signup')
  })

  it('without an upgrade path (self-hosted) it still renders the message alone', () => {
    const result: TierLimitBlockedResult = {
      status: 'error',
      code: 'tier_limit_reached',
      limitKey: 'live_projects',
      message: 'This action isn\'t available on your current plan. Upgrade to unlock it.',
    }
    render(<TierLimitNotice result={result} upgrade={null} />)
    assert.ok(screen.getByTestId('tier-limit-notice'))
    assert.equal(screen.queryByTestId('tier-limit-upgrade'), null)
  })
})

describe('WorkspaceInviteForm seat-cap refusal', () => {
  it('renders the refusal notice with the upgrade path when the action returns the typed tier result', async () => {
    const blocked: TierLimitBlockedResult = {
      status: 'error',
      code: 'tier_limit_reached',
      limitKey: 'seats',
      message: 'Seat limit reached (2 of 2 seats in use, counting members and pending invites). Remove a person or upgrade to add more.',
    }
    render(<WorkspaceInviteForm invite={async () => blocked} upgrade={{ label: 'Upgrade', href: '/signup' }} />)
    fireEvent.change(screen.getByPlaceholderText('Invite email'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => assert.ok(screen.queryByTestId('tier-limit-notice'), 'tier refusal notice renders'))
    assert.match(screen.getByTestId('tier-limit-notice').textContent ?? '', /Seat limit reached/)
    assert.equal(screen.getByTestId('tier-limit-upgrade').getAttribute('href'), '/signup')
    assert.equal(screen.queryByTestId('verify-email-required'), null, 'not the verify-email state')
  })

  it('a successful invite leaves no tier state', async () => {
    render(<WorkspaceInviteForm invite={async () => undefined} upgrade={{ label: 'Upgrade', href: '/signup' }} />)
    fireEvent.change(screen.getByPlaceholderText('Invite email'), { target: { value: 'new@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }))
    await waitFor(() => assert.equal(screen.queryByTestId('tier-limit-notice'), null))
  })
})

describe('CreateProjectModal live-project cap refusal', () => {
  it('renders the refusal notice with the upgrade path in the create dialog', async () => {
    const blocked: TierLimitBlockedResult = {
      status: 'error',
      code: 'tier_limit_reached',
      limitKey: 'live_projects',
      message: 'Live project limit reached (2 of 2 projects live at once). Pause or archive a project, or upgrade to run more.',
    }
    render(<CreateProjectModal create={async () => blocked} upgrade={{ label: 'Upgrade', href: '/signup' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    fireEvent.change(screen.getByPlaceholderText('Refunds'), { target: { value: 'Over cap' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => assert.ok(screen.queryByTestId('tier-limit-notice'), 'tier refusal notice renders in the dialog'))
    assert.match(screen.getByTestId('tier-limit-notice').textContent ?? '', /Live project limit reached \(2 of 2/)
    assert.equal(screen.getByTestId('tier-limit-upgrade').getAttribute('href'), '/signup')
  })
})
