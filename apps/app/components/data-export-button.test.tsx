import 'global-jsdom/register'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render test for the "Export my data" button. jsdom is registered for this
 * file only; fetch, URL.createObjectURL and link clicks are stubbed. Covers
 * the download path, the 401 / 429 (Retry-After in minutes) / generic
 * failure messages, and that the button cannot fire twice while pending.
 *
 * Mutant notes: dropping the Retry-After handling shows the bare limited
 * message (minute test goes RED); returning before setting pending=false on
 * failure leaves the button disabled (failure test goes RED).
 */

import {
  DataExportButton,
  EXPORT_ENDPOINT,
  EXPORT_FAILURE_MESSAGE,
  EXPORT_LIMITED_MESSAGE,
  EXPORT_SUCCESS_MESSAGE,
  retryAfterMinutes,
} from './data-export-button'

const realFetch = globalThis.fetch
const objectUrls: string[] = []

function mockFetch(impl: () => Promise<Response>) {
  globalThis.fetch = (() => impl()) as typeof fetch
}

beforeEach(() => {
  URL.createObjectURL = (() => {
    const url = `blob:mock/${objectUrls.length}`
    objectUrls.push(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
})

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

function button() {
  return screen.getByRole('button', { name: /export my data|preparing export/i }) as HTMLButtonElement
}

async function click() {
  fireEvent.click(button())
}

describe('retryAfterMinutes', () => {
  it('rounds seconds up to whole minutes and rejects junk', () => {
    assert.equal(retryAfterMinutes('3600'), '60')
    assert.equal(retryAfterMinutes('90'), '2')
    assert.equal(retryAfterMinutes('1'), '1')
    assert.equal(retryAfterMinutes('0'), null)
    assert.equal(retryAfterMinutes('abc'), null)
    assert.equal(retryAfterMinutes(null), null)
  })
})

describe('DataExportButton', () => {
  it('downloads the blob on success and shows the success line', async () => {
    const clicked: string[] = []
    const realCreate = document.createElement.bind(document)
    document.createElement = ((tag: string) => {
      const el = realCreate(tag)
      if (tag === 'a') el.click = () => clicked.push(el.getAttribute('download') ?? '')
      return el
    }) as typeof document.createElement

    let requested = ''
    mockFetch(async () => {
      requested = 'hit'
      return new Response(new Blob(['zip-bytes']), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="hitly-data-export-2026-11-13.zip"',
        },
      })
    })

    render(<DataExportButton />)
    await click()
    await waitFor(() => assert.ok(screen.getByRole('status')))
    assert.equal(requested, 'hit')
    assert.equal(screen.getByRole('status').textContent, EXPORT_SUCCESS_MESSAGE)
    assert.deepEqual(clicked, ['hitly-data-export-2026-11-13.zip'])
    assert.equal(button().disabled, false)
  })

  it('posts to the export endpoint with credentials', async () => {
    const calls: RequestInit[] = []
    mockFetch(async () => {
      return new Response(new Blob(['z']), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      calls.push(init ?? {})
      assert.equal(input, EXPORT_ENDPOINT)
      return originalFetch(input as never, init)
    }) as typeof fetch
    render(<DataExportButton />)
    await click()
    await waitFor(() => assert.ok(screen.getByRole('status')))
    assert.equal(calls[0]?.method, 'POST')
    assert.equal(calls[0]?.credentials, 'include')
  })

  it('shows the sign-in hint on 401', async () => {
    mockFetch(async () => new Response('{}', { status: 401 }))
    render(<DataExportButton />)
    await click()
    const alert = await screen.findByRole('alert')
    assert.match(alert.textContent ?? '', /sign in again/i)
  })

  it('shows remaining minutes on 429 with Retry-After', async () => {
    mockFetch(async () => new Response('{}', { status: 429, headers: { 'retry-after': '1800' } }))
    render(<DataExportButton />)
    await click()
    const alert = await screen.findByRole('alert')
    assert.ok((alert.textContent ?? '').startsWith(EXPORT_LIMITED_MESSAGE))
    assert.match(alert.textContent ?? '', /about 30 minutes left/)
  })

  it('shows the fixed retry message on any other failure', async () => {
    mockFetch(async () => {
      throw new Error('network down')
    })
    render(<DataExportButton />)
    await click()
    const alert = await screen.findByRole('alert')
    assert.equal(alert.textContent, EXPORT_FAILURE_MESSAGE)
    await waitFor(() => assert.equal(button().disabled, false))
  })

  it('ignores double clicks while pending', async () => {
    let release!: () => void
    let calls = 0
    mockFetch(
      () => {
        calls += 1
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response(new Blob(['z']), { status: 200 }))
        })
      },
    )
    render(<DataExportButton />)
    await click()
    assert.equal(button().disabled, true)
    await click()
    assert.equal(calls, 1, 'second click while pending must not fire a request')
    release()
    await waitFor(() => assert.equal(button().disabled, false))
  })
})
