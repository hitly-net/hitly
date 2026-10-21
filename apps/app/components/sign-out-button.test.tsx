import 'global-jsdom/register'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render test for the sign-out button. jsdom is registered for this file only
 * (global-jsdom/register above). fetch is replaced per test; the button runs
 * the real performSignOut and the real outcome-to-message mapping.
 *
 * Run with: yarn workspace @hitly/app test
 */

import { SignOutButton } from './sign-out-button'
import { SIGN_OUT_FAILURE_MESSAGE, SIGN_OUT_SERVER_FAILURE_MESSAGE } from '@/lib/sign-out'

const RAW = 'raw server detail: stack trace at line 42'

const realFetch = globalThis.fetch
const realConsoleError = console.error
let fetchCalls = 0

function mockFetch(impl: () => Promise<Response>) {
  globalThis.fetch = (() => {
    fetchCalls += 1
    return impl()
  }) as typeof fetch
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function button() {
  return screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement
}

async function clickAndReadAlert() {
  fireEvent.click(button())
  const alert = await screen.findByRole('alert')
  await waitFor(() => assert.equal(button().disabled, false))
  return alert
}

beforeEach(() => {
  fetchCalls = 0
  console.error = () => {}
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  console.error = realConsoleError
})

describe('SignOutButton', () => {
  it('renders the button with no message before it is used', () => {
    render(<SignOutButton />)
    assert.equal(button().disabled, false)
    assert.equal(screen.queryByRole('alert'), null)
  })

  it("shows the signed-out-on-this-device message for the route's sign_out_failed 500", async () => {
    mockFetch(async () => jsonResponse(500, { error: 'sign_out_failed' }))
    render(<SignOutButton />)
    const alert = await clickAndReadAlert()
    assert.equal(alert.textContent, SIGN_OUT_SERVER_FAILURE_MESSAGE)
  })

  it('shows the still-signed-in message for any other 500', async () => {
    for (const make of [
      () => jsonResponse(500, { error: 'internal_error' }),
      () => new Response('<html><body>Internal Server Error</body></html>', { status: 500, headers: { 'content-type': 'text/html' } }),
    ]) {
      mockFetch(async () => make())
      render(<SignOutButton />)
      const alert = await clickAndReadAlert()
      assert.equal(alert.textContent, SIGN_OUT_FAILURE_MESSAGE)
      cleanup()
    }
  })

  it('never shows raw error text from the server or the network', async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => jsonResponse(500, { error: RAW }),
      async () => jsonResponse(500, { error: 'sign_out_failed', message: RAW }),
      async () => jsonResponse(403, { error: RAW }),
      async () => new Response(RAW, { status: 500, headers: { 'content-type': 'text/plain' } }),
      async () => {
        throw new TypeError(RAW)
      },
    ]
    for (const failure of failures) {
      mockFetch(failure)
      render(<SignOutButton />)
      const alert = await clickAndReadAlert()
      assert.ok(
        alert.textContent === SIGN_OUT_FAILURE_MESSAGE || alert.textContent === SIGN_OUT_SERVER_FAILURE_MESSAGE,
        `unexpected message: ${alert.textContent}`,
      )
      assert.ok(!document.body.textContent?.includes(RAW), 'raw error text must not be rendered')
      cleanup()
    }
  })

  it('disables itself while the request is in flight and ignores repeat clicks', async () => {
    let finish: (response: Response) => void = () => {}
    mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)))
    render(<SignOutButton />)
    fireEvent.click(button())
    await waitFor(() => assert.equal(button().disabled, true))
    fireEvent.click(button())
    fireEvent.click(button())
    assert.equal(fetchCalls, 1, 'only one request per click while pending')
    finish(jsonResponse(415, { error: 'unsupported_media_type' }))
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, SIGN_OUT_FAILURE_MESSAGE)
    await waitFor(() => assert.equal(button().disabled, false))
  })

  it('clears the previous message when retried', async () => {
    let finish: (response: Response) => void = () => {}
    mockFetch(async () => jsonResponse(500, { error: 'internal_error' }))
    render(<SignOutButton />)
    await clickAndReadAlert()
    mockFetch(() => new Promise<Response>((resolve) => (finish = resolve)))
    fireEvent.click(button())
    await waitFor(() => assert.equal(screen.queryByRole('alert'), null))
    finish(jsonResponse(500, { error: 'internal_error' }))
    await screen.findByRole('alert')
  })
})

describe('SignOutButton unexpected error', () => {
  it('shows the fixed copy when sign-out throws unexpectedly', async () => {
    const logged: string[] = []
    // Make the sign-out helper's own logging throw so the error escapes it
    // and reaches the button's catch branch.
    console.error = (...args: unknown[]) => {
      const first = String(args[0])
      logged.push(first)
      if (!first.includes('Unexpected')) throw new Error(RAW)
    }
    mockFetch(async () => jsonResponse(403, { error: 'forbidden' }))
    render(<SignOutButton />)
    const alert = await clickAndReadAlert()
    assert.equal(alert.textContent, SIGN_OUT_FAILURE_MESSAGE)
    assert.ok(!alert.textContent?.includes(RAW))
    assert.ok(logged.some((line) => line.includes('Unexpected sign-out error')), 'the unexpected-error branch ran')
  })
})

