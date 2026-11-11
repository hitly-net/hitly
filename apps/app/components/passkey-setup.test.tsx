import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PasskeySetup } from './passkey-setup'
import { CURRENT_PASSWORD_INCORRECT_MESSAGE, PASSKEY_REMOVED_MESSAGE } from '@/lib/passkey'

const realFetch = globalThis.fetch
globalThis.FormData = window.FormData

const sample = [
  {
    id: 'pk_1',
    name: 'Laptop',
    createdAt: '2026-01-02T03:04:05.000Z',
    lastUsedAt: '2026-01-03T03:04:05.000Z',
  },
]

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('PasskeySetup', () => {
  it('lists name, created and last used, and shows the empty state', () => {
    render(<PasskeySetup passkeys={sample} />)
    assert.ok(screen.getByText('Laptop'))
    assert.ok(screen.getByText(/Created/))
    assert.ok(screen.getByText(/Last used/))
    cleanup()
    render(<PasskeySetup passkeys={[]} />)
    assert.ok(screen.getByText('No passkeys yet.'))
  })

  it('requires the current password to add a passkey and maps a wrong password', async () => {
    mockFetch(400, { code: 'INVALID_PASSWORD' })
    render(<PasskeySetup passkeys={[]} />)
    const addForm = screen.getByRole('button', { name: 'Add passkey' }).closest('form')!
    assert.equal(addForm.querySelector('input[name="currentPassword"]')?.getAttribute('type'), 'password')
    fireEvent.change(addForm.querySelector('input[name="name"]') as HTMLInputElement, { target: { value: 'Phone' } })
    fireEvent.change(addForm.querySelector('input[name="currentPassword"]') as HTMLInputElement, {
      target: { value: 'wrong-password' },
    })
    fireEvent.submit(addForm)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, CURRENT_PASSWORD_INCORRECT_MESSAGE))
  })

  it('sends the current password when deleting a listed passkey', async () => {
    const bodies: Array<{ currentPassword?: string }> = []
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as { currentPassword?: string })
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    render(<PasskeySetup passkeys={sample} />)
    const deleteForm = screen.getByRole('button', { name: 'Delete passkey' }).closest('form')!
    fireEvent.change(deleteForm.querySelector('input[name="currentPassword"]') as HTMLInputElement, {
      target: { value: 'old-password-1' },
    })
    fireEvent.submit(deleteForm)
    await waitFor(() => assert.equal(screen.getByRole('status').textContent, PASSKEY_REMOVED_MESSAGE))
    assert.deepEqual(bodies[0], { currentPassword: 'old-password-1' })
    assert.equal(screen.queryByText('Laptop'), null)
  })
})
