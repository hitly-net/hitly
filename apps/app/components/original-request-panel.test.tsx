import 'global-jsdom/register'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OriginalRequestPanel } from './original-request-panel'
import { REDACTED, redactedRequestJson } from '@/lib/redact-request-payload'

const TOKEN = 'cb-auth-secret-value'
const HANDLE = 'https://origin.example/resume?x=1'
const PAYLOAD = {
  action: { name: 'pay', args: { amount: 100, currency: 'EUR', cb_auth_token: TOKEN } },
  origin: { plugin: 'http', runId: 'run_1', resumeHandle: { resumeUrl: HANDLE } },
}
const CANONICAL = JSON.stringify(PAYLOAD)
const DISPLAY = redactedRequestJson(PAYLOAD)
const PAYLOAD_HASH = 'payload-hash-abc'
const ARGS_HASH = 'args-hash-xyz'

const realFetch = globalThis.fetch
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL
const realAppendChild = Node.prototype.appendChild
let clipboardText: string | null = null
let objectUrlBlob: Blob | null = null
let downloadFilename = ''

beforeEach(() => {
  clipboardText = null
  objectUrlBlob = null
  downloadFilename = ''
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        clipboardText = text
      },
    },
  })
  URL.createObjectURL = ((blob: Blob) => {
    objectUrlBlob = blob
    return 'blob:test-original-request'
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = () => {}
  Node.prototype.appendChild = function appendChild<T extends Node>(node: T): T {
    if (node instanceof HTMLAnchorElement) downloadFilename = node.download
    return realAppendChild.call(this, node) as T
  }
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: true,
        requestId: 'apr_1',
        canonicalPayload: CANONICAL,
        payloadSha256: 'deadbeef',
        argsSha256: 'cafebabe',
        payloadHash: PAYLOAD_HASH,
        argsHash: ARGS_HASH,
        // Must never be treated as the original request (hitly#98).
        editedArgs: { amount: 1, cb_auth_token: TOKEN },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  Node.prototype.appendChild = realAppendChild
})

async function openPanel() {
  render(<OriginalRequestPanel approvalId="apr_1" />)
  fireEvent.click(screen.getByRole('button', { name: 'View original request' }))
  await waitFor(() => assert.ok(screen.getByTestId('original-request-json')))
}

describe('OriginalRequestPanel', () => {
  it('renders the original request JSON, payloadHash and argsHash', async () => {
    await openPanel()
    const pre = screen.getByTestId('original-request-json')
    assert.equal(pre.textContent, DISPLAY)
    assert.ok(screen.getByText(new RegExp(`payloadHash\\s+${PAYLOAD_HASH}`)))
    assert.ok(screen.getByText(new RegExp(`argsHash\\s+${ARGS_HASH}`)))
    assert.ok(screen.getByRole('button', { name: 'Copy' }))
    assert.ok(screen.getByRole('button', { name: 'Download (JSON)' }))
    assert.equal(screen.queryByRole('textbox'), null)
    assert.equal(document.querySelector('textarea, input'), null)
  })

  it('redacts secrets in display, copy and download', async () => {
    await openPanel()
    const pre = screen.getByTestId('original-request-json')
    assert.equal(pre.textContent?.includes(TOKEN), false)
    assert.equal(pre.textContent?.includes(HANDLE), false)
    assert.ok(pre.textContent?.includes(REDACTED))
    assert.ok(pre.textContent?.includes('100'))

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => assert.equal(clipboardText, DISPLAY))
    assert.equal(clipboardText?.includes(TOKEN), false)
    assert.equal(clipboardText?.includes(HANDLE), false)

    fireEvent.click(screen.getByRole('button', { name: 'Download (JSON)' }))
    assert.equal(downloadFilename, 'original-request-apr_1.json')
    assert.ok(objectUrlBlob)
    assert.equal(objectUrlBlob.type, 'application/json')
    const downloaded = await objectUrlBlob.text()
    assert.equal(downloaded, DISPLAY)
    assert.equal(downloaded.includes(TOKEN), false)
    assert.equal(downloaded.includes(HANDLE), false)
  })

  it('never shows editedArgs as the original request', async () => {
    await openPanel()
    const shown = JSON.parse(screen.getByTestId('original-request-json').textContent ?? '') as {
      action?: { args?: { amount?: number } }
      editedArgs?: unknown
    }
    assert.equal(shown.action?.args?.amount, 100)
    assert.equal('editedArgs' in shown, false)
    assert.equal(screen.queryByTestId('edited-args-panel'), null)
    assert.equal(screen.queryByRole('heading', { name: 'Edited arguments' }), null)
  })
})
