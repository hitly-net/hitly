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

async function openPanel(rawStoredView?: Record<string, unknown> | null) {
  render(<OriginalRequestPanel approvalId="apr_1" rawStoredView={rawStoredView} />)
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

  it('redacts a secret-like canary when canonicalPayload is invalid JSON (fallback bypass must go red)', async () => {
    const canary = ['raw', 'json', 'fallback', 'canary', 'value'].join('-')
    const invalid = `{"apiKey":"${canary}","tokenCount":9,"amount":1`
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          requestId: 'apr_1',
          canonicalPayload: invalid,
          payloadSha256: 'deadbeef',
          argsSha256: 'cafebabe',
          payloadHash: PAYLOAD_HASH,
          argsHash: ARGS_HASH,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch
    await openPanel()
    const shown = screen.getByTestId('original-request-json').textContent ?? ''
    assert.equal(shown.includes(canary), false, 'invalid-JSON fallback must redact the canary')
    assert.ok(shown.includes(REDACTED))
    assert.ok(shown.includes('tokenCount'))
    assert.ok(shown.includes('9'))
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

  it('renders exactly one JSON panel: no separate "Full JSON" panel', async () => {
    await openPanel({
      origin: { plugin: 'http', runId: 'run_9' },
      metadata: { note: 'meta-visible' },
    })
    assert.equal(screen.queryByText('Full JSON'), null)
    // The only <pre> on the page is the original-request JSON; the raw
    // stored view is collapsed and its <pre> is not mounted.
    assert.equal(document.querySelectorAll('pre').length, 1)
    assert.equal(document.querySelector('pre')?.dataset.testid, 'original-request-json')
    assert.equal(document.querySelectorAll('summary').length, 0)
  })

  it('Raw stored view is collapsed by default, expands, and stays redacted', async () => {
    const rawCanary = ['raw', 'stored', 'secret', 'canary'].join('-')
    const raw = {
      origin: {
        plugin: 'http',
        runId: 'run_9',
        cb_auth_token: TOKEN,
        resumeHandle: { resumeUrl: HANDLE },
      },
      metadata: { note: 'meta-visible', apiKey: rawCanary },
    }
    await openPanel(raw)

    // Collapsed by default: the toggle is there, its content is not mounted.
    const toggle = screen.getByRole('button', { name: 'Raw stored view' })
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(screen.queryByTestId('raw-stored-view-json'), null)

    fireEvent.click(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    const pre = screen.getByTestId('raw-stored-view-json')
    const shown = pre.textContent ?? ''
    // Extra fields are present...
    assert.ok(shown.includes('run_9'), 'origin reference must be visible')
    assert.ok(shown.includes('meta-visible'), 'metadata bag must be visible')
    // ...and redacted the same way as the original request.
    assert.equal(shown.includes(TOKEN), false)
    assert.equal(shown.includes(HANDLE), false)
    assert.equal(shown.includes(rawCanary), false)
    assert.ok(shown.includes(REDACTED))

    // Collapses again.
    fireEvent.click(toggle)
    assert.equal(screen.queryByTestId('raw-stored-view-json'), null)

    // Copy/Download stay scoped to the original request, not the raw view.
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => assert.equal(clipboardText, DISPLAY))
    fireEvent.click(screen.getByRole('button', { name: 'Download (JSON)' }))
    assert.equal(downloadFilename, 'original-request-apr_1.json')
    const blob = objectUrlBlob
    if (!blob) throw new Error('expected a downloaded blob')
    assert.equal(await blob.text(), DISPLAY)
  })

  it('shows no Raw stored view toggle when there are no extra stored fields', async () => {
    await openPanel(undefined)
    assert.equal(screen.queryByRole('button', { name: 'Raw stored view' }), null)
    await cleanup()
    await openPanel({})
    assert.equal(screen.queryByRole('button', { name: 'Raw stored view' }), null)
  })
})
