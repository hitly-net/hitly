import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { EditedArgsPanel, editedArgsFromPayload, omitEditedArgs } from './edited-args-panel'
import { REDACTED } from '@/lib/redact-request-payload'

afterEach(() => cleanup())

describe('editedArgsFromPayload / omitEditedArgs', () => {
  it('reads editedArgs from a decide payload and omits them elsewhere', () => {
    const payload = { decision: 'edit', editedArgs: { amount: 55 }, reason: 'ok' }
    assert.deepEqual(editedArgsFromPayload(payload), { amount: 55 })
    assert.deepEqual(omitEditedArgs(payload), { decision: 'edit', reason: 'ok' })
    assert.equal(editedArgsFromPayload({ decision: 'accept' }), null)
    assert.equal(editedArgsFromPayload(null), null)
  })
})

describe('EditedArgsPanel', () => {
  it('renders nothing when there are no edited args', () => {
    const { container } = render(<EditedArgsPanel editedArgs={null} />)
    assert.equal(container.textContent, '')
    assert.equal(screen.queryByTestId('edited-args-panel'), null)
  })

  it('labels edited args as amendments, never as the original request', () => {
    render(<EditedArgsPanel editedArgs={{ amount: 55, cb_auth_token: 'tok_should_not_show' }} />)
    const panel = screen.getByTestId('edited-args-panel')
    assert.equal(screen.getByRole('heading', { name: 'Edited arguments' }).textContent, 'Edited arguments')
    assert.ok(panel.textContent?.includes('not the original create-once request'))
    assert.equal(screen.queryByText(/view original request/i), null)
    assert.ok(panel.textContent?.includes('55'))
    assert.equal(panel.textContent?.includes('tok_should_not_show'), false)
    assert.ok(panel.textContent?.includes(REDACTED))
  })
})
