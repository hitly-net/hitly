import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MfaSetup } from './mfa-setup'
import { CURRENT_PASSWORD_INCORRECT_MESSAGE, MFA_ENROL_SUCCEEDED_MESSAGE } from '@/lib/mfa'

const realFetch = globalThis.fetch
globalThis.FormData = window.FormData

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('MfaSetup', () => {
  it('requires the current password to start enrolment', () => {
    render(<MfaSetup status={{ enabled: false, pending: false, recoveryCodesRemaining: 0 }} />)
    assert.equal(document.querySelector('input[name="currentPassword"]')?.getAttribute('type'), 'password')
  })

  it('shows the shared current-password message when re-auth fails', async () => {
    mockFetch(400, { code: 'INVALID_PASSWORD' })
    render(<MfaSetup status={{ enabled: false, pending: false, recoveryCodesRemaining: 0 }} />)
    fireEvent.change(document.querySelector('input[name="currentPassword"]') as HTMLInputElement, {
      target: { value: 'wrong-password' },
    })
    fireEvent.submit(document.querySelector('form')!)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, CURRENT_PASSWORD_INCORRECT_MESSAGE))
  })

  it('shows the QR, secret, recovery codes, and confirm field after enrol', async () => {
    mockFetch(200, {
      otpauthUri: 'otpauth://totp/HITLy:alex%40example.com?secret=MFRGGZDFMZTWQ2LK',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      secret: 'MFRGGZDFMZTWQ2LK',
      recoveryCodes: ['ABCD-EFGH'],
    })
    render(<MfaSetup status={{ enabled: false, pending: false, recoveryCodesRemaining: 0 }} />)
    fireEvent.change(document.querySelector('input[name="currentPassword"]') as HTMLInputElement, {
      target: { value: 'old-password-1' },
    })
    fireEvent.submit(document.querySelector('form')!)
    await waitFor(() => assert.ok(document.querySelector('input[name="code"]')))
    assert.equal((document.querySelector('input[readOnly]') as HTMLInputElement).value, 'MFRGGZDFMZTWQ2LK')
    assert.ok(screen.getByText('ABCD-EFGH'))
  })

  it('shows the enabled state after a successful confirm', async () => {
    let calls = 0
    globalThis.fetch = (async (_input, init) => {
      calls += 1
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            otpauthUri: 'otpauth://totp/HITLy:a',
            qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
            secret: 'MFRGGZDFMZTWQ2LK',
            recoveryCodes: ['ABCD-EFGH'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { code?: string }
      assert.equal(body.code, '123456')
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    render(<MfaSetup status={{ enabled: false, pending: false, recoveryCodesRemaining: 0 }} />)
    fireEvent.change(document.querySelector('input[name="currentPassword"]') as HTMLInputElement, {
      target: { value: 'old-password-1' },
    })
    fireEvent.submit(document.querySelector('form')!)
    await waitFor(() => assert.ok(document.querySelector('input[name="code"]')))
    fireEvent.change(document.querySelector('input[name="code"]') as HTMLInputElement, { target: { value: '123456' } })
    fireEvent.submit(document.querySelector('form')!)
    const status = await screen.findByRole('status')
    assert.equal(status.textContent, MFA_ENROL_SUCCEEDED_MESSAGE)
  })
})
