import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MfaVerifyForm } from './mfa-verify-form'
import { MFA_INVALID_CODE_MESSAGE } from '@/lib/mfa'

const realFetch = globalThis.fetch
globalThis.FormData = window.FormData

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

describe('MfaVerifyForm', () => {
  it('posts the authenticator or recovery code', async () => {
    let posted: unknown
    globalThis.fetch = (async (_input, init) => {
      posted = JSON.parse(String(init?.body ?? '{}'))
      return new Response(JSON.stringify({ error: 'invalid_code' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    render(<MfaVerifyForm />)
    fireEvent.change(document.querySelector('input[name="code"]') as HTMLInputElement, { target: { value: '123456' } })
    fireEvent.submit(document.querySelector('form')!)
    await waitFor(() => assert.equal(screen.getByRole('alert').textContent, MFA_INVALID_CODE_MESSAGE))
    assert.deepEqual(posted, { code: '123456' })
  })
})
