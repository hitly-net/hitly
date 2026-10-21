import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Render test for the account menu. jsdom is registered for this file only
 * (global-jsdom/register above), so other tests keep running in plain Node.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { UserMenu } from './user-menu'

const EMAIL = 'alex.longname.for.truncation@example.com'

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /Alex/ }))
}

afterEach(() => cleanup())

describe('UserMenu email', () => {
  it('shows the email under the name at the top of the menu', () => {
    render(<UserMenu userName="Alex" userEmail={EMAIL} />)
    openMenu()
    const menu = screen.getByRole('menu')
    const email = screen.getByTestId('user-menu-email')
    assert.equal(email.textContent, EMAIL)
    assert.ok(menu.contains(email))
    const header = email.parentElement!
    assert.equal(header.firstElementChild?.textContent, 'Alex')
    assert.equal(header, menu.firstElementChild, 'name and email lead the menu')
  })

  it('keeps the full email in the title and truncates the text', () => {
    render(<UserMenu userName="Alex" userEmail={EMAIL} />)
    openMenu()
    const email = screen.getByTestId('user-menu-email')
    assert.equal(email.getAttribute('title'), EMAIL)
    assert.ok(email.classList.contains('truncate'))
    assert.ok(email.classList.contains('text-xs'))
    assert.ok(email.classList.contains('text-zinc-500'))
  })

  it('gives the trigger the email as a tooltip', () => {
    render(<UserMenu userName="Alex" userEmail={EMAIL} />)
    assert.equal(screen.getByRole('button', { name: /Alex/ }).getAttribute('title'), EMAIL)
  })

  it('renders nothing extra without an email', () => {
    for (const userEmail of [undefined, null, '', '  ']) {
      render(<UserMenu userName="Alex" userEmail={userEmail} />)
      const trigger = screen.getByRole('button', { name: /Alex/ })
      assert.equal(trigger.hasAttribute('title'), false)
      openMenu()
      assert.equal(screen.queryByTestId('user-menu-email') === null, true, `email element rendered for ${JSON.stringify(userEmail)}`)
      cleanup()
    }
  })
})
