import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProjectApiKeys } from './project-api-keys'
import type { ApiKeyActionResult } from '@/actions/projects'
import { gateBlockedResult } from '@/lib/verified-gate'

/**
 * Render tests for the gated key panel (S1/S2): a gate-blocked create or
 * regenerate renders the "Verify your email to continue" state — NOT a raw
 * key, not a throw — while successful results still surface the one-time
 * secret. Actions are injected so the component state machine is tested
 * without a server.
 */

globalThis.FormData = window.FormData

const keys = [{ id: 'k1', name: 'Ingest key', prefix: 'hitly_oldpref', lastUsedAt: null }]

afterEach(() => cleanup())

function blocked(): ApiKeyActionResult {
  return gateBlockedResult()
}

describe('ProjectApiKeys gate-blocked states', () => {
  it('a blocked key create renders the verify state and no secret, without throwing', async () => {
    const seen: FormData[] = []
    render(
      <ProjectApiKeys
        projectId="p1"
        keys={keys}
        createKey={async (_projectId, formData) => {
          seen.push(formData)
          return blocked()
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required'), 'blocked state renders'))
    const box = screen.getByTestId('verify-email-required')
    assert.match(box.textContent ?? '', /Verify your email to continue/)
    assert.equal(screen.queryByText(/Copy now/), null, 'no secret panel after a refusal')
    assert.equal(seen.length, 1, 'the action was awaited, not thrown past')
  })

  it('a successful key create still shows the one-time secret and no verify state', async () => {
    render(<ProjectApiKeys projectId="p1" keys={keys} createKey={async () => ({ apiKey: 'hitly_newsecret' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await waitFor(() => assert.match(document.body.textContent ?? '', /hitly_newsecret/))
    assert.equal(screen.queryByTestId('verify-email-required'), null)
  })

  it('a blocked regenerate renders the verify state, keeps listing the old key, and shows no new secret', async () => {
    ;(globalThis as { confirm?: unknown }).confirm = () => true
    ;(window as unknown as { confirm?: unknown }).confirm = () => true
    let regenerateCalls = 0
    render(
      <ProjectApiKeys
        projectId="p1"
        keys={keys}
        createKey={async () => blocked()}
        regenerate={async () => {
          regenerateCalls += 1
          return blocked()
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required'), 'blocked state renders'))
    assert.equal(regenerateCalls, 1)
    assert.match(document.body.textContent ?? '', /hitly_oldpref/, 'the existing key row is untouched in the list')
    assert.equal(screen.queryByText(/Copy now/), null, 'no new working key is produced')
  })

  it('a successful regenerate shows the fresh secret and no verify state', async () => {
    ;(globalThis as { confirm?: unknown }).confirm = () => true
    ;(window as unknown as { confirm?: unknown }).confirm = () => true
    render(
      <ProjectApiKeys
        projectId="p1"
        keys={keys}
        createKey={async () => blocked()}
        regenerate={async () => ({ apiKey: 'hitly_rotated' })}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await waitFor(() => assert.match(document.body.textContent ?? '', /hitly_rotated/))
    assert.equal(screen.queryByTestId('verify-email-required'), null)
  })

  it('a later success clears the previous blocked state', async () => {
    let createKey: (projectId: string, formData: FormData) => Promise<ApiKeyActionResult> = async () => blocked()
    render(<ProjectApiKeys projectId="p1" keys={keys} createKey={(p, f) => createKey(p, f)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await waitFor(() => assert.ok(screen.queryByTestId('verify-email-required')))
    createKey = async () => ({ apiKey: 'hitly_later' })
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }))
    await waitFor(() => assert.match(document.body.textContent ?? '', /hitly_later/))
    assert.equal(screen.queryByTestId('verify-email-required'), null, 'stale blocked state is cleared')
  })
})
