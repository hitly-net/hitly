import 'global-jsdom/register'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

/**
 * Render test for the "Request my data" button. jsdom is registered for this
 * file only; fetch is stubbed. Covers: the POST contract (endpoint, method,
 * credentials, JSON body), the UK GDPR confirmation (names "UK GDPR", "one
 * month" and the deadline date), the already-open (200) answer, the 401 /
 * 429 (Retry-After in minutes) / generic failure and network-failure
 * messages, a missing/garbage response body, and that the button cannot fire
 * twice while pending.
 *
 * Mutant notes: dropping the Retry-After handling shows the bare limited
 * message (minute test goes RED); returning before setting pending=false on
 * failure leaves the button disabled (failure test goes RED); dropping the
 * responseBy date from the confirmation fails the deadline assertion.
 */

import {
  DATA_REQUEST_ENDPOINT,
  DATA_REQUEST_FAILURE_MESSAGE,
  DATA_REQUEST_LIMITED_MESSAGE,
  DataRequestButton,
  dataRequestConfirmation,
  retryAfterMinutes,
} from './data-request-button'

const realFetch = globalThis.fetch

function mockFetch(impl: () => Promise<Response>) {
  globalThis.fetch = (() => impl()) as typeof fetch
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  cleanup()
  globalThis.fetch = realFetch
})

function button() {
  return screen.getByRole('button', { name: /request my data|sending request/i }) as HTMLButtonElement
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

describe('dataRequestConfirmation', () => {
  it('names UK GDPR, the one-month window and the deadline date', () => {
    const text = dataRequestConfirmation('2026-12-15T09:00:00.000Z')
    assert.match(text, /UK GDPR/)
    assert.match(text, /one month/)
    assert.match(text, /15 December 2026/)
  })

  it('still names the UK GDPR window when the date is missing or junk', () => {
    for (const value of [undefined, 'not-a-date', '']) {
      const text = dataRequestConfirmation(value)
      assert.match(text, /UK GDPR/)
      assert.match(text, /one month/)
    }
  })
})

describe('DataRequestButton', () => {
  it('posts the ask once and confirms with the UK GDPR deadline', async () => {
    const calls: RequestInit[] = []
    const urls: string[] = []
    mockFetch(async () => {
      return jsonResponse(201, {
        status: 'open',
        requestedAt: '2026-11-15T09:00:00.000Z',
        responseBy: '2026-12-15T09:00:00.000Z',
      })
    })
    const realFetchSpy = globalThis.fetch
    render(<DataRequestButton />)
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      urls.push(String(url))
      if (init) calls.push(init)
      return realFetchSpy(url as string, init)
    }) as typeof fetch

    fireEvent.click(button())
    await waitFor(() => screen.getByRole('status'))
    assert.deepEqual(urls, [DATA_REQUEST_ENDPOINT])
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].credentials, 'include')
    assert.equal(calls[0].body, '{}')
    const status = screen.getByRole('status')
    assert.match(status.textContent ?? '', /UK GDPR/)
    assert.match(status.textContent ?? '', /one month/)
    assert.match(status.textContent ?? '', /15 December 2026/)
  })

  it('confirms an already-open request (200) identically', async () => {
    mockFetch(async () =>
      jsonResponse(200, {
        status: 'open',
        requestedAt: '2026-11-10T08:00:00.000Z',
        responseBy: '2026-12-10T08:00:00.000Z',
      }),
    )
    render(<DataRequestButton />)
    fireEvent.click(button())
    await waitFor(() => screen.getByRole('status'))
    assert.match(screen.getByRole('status').textContent ?? '', /10 December 2026/)
  })

  it('confirms even when the response body is unusable', async () => {
    mockFetch(async () => new Response('not json', { status: 200 }))
    render(<DataRequestButton />)
    fireEvent.click(button())
    await waitFor(() => screen.getByRole('status'))
    assert.match(screen.getByRole('status').textContent ?? '', /UK GDPR/)
  })

  it('shows the sign-in message on 401', async () => {
    mockFetch(async () => jsonResponse(401, { error: 'unauthorized' }))
    render(<DataRequestButton />)
    fireEvent.click(button())
    await waitFor(() => screen.getByRole('alert'))
    assert.match(screen.getByRole('alert').textContent ?? '', /sign in again/i)
  })

  it('shows Retry-After minutes on 429', async () => {
    mockFetch(async () => jsonResponse(429, { error: 'too_many_requests' }, { 'retry-after': '3600' }))
    render(<DataRequestButton />)
    fireEvent.click(button())
    await waitFor(() => screen.getByRole('alert'))
    assert.match(screen.getByRole('alert').textContent ?? '', /about 60 minutes/)
    assert.ok((screen.getByRole('alert').textContent ?? '').startsWith(DATA_REQUEST_LIMITED_MESSAGE))
  })

  it('shows the fixed failure message on 500 and on network failure', async () => {
    mockFetch(async () => jsonResponse(500, { error: 'data_request_failed' }))
    render(<DataRequestButton />)
    fireEvent.click(button())
    await waitFor(() => screen.getByRole('alert'))
    assert.equal(screen.getByRole('alert').textContent, DATA_REQUEST_FAILURE_MESSAGE)
    cleanup()

    mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    render(<DataRequestButton />)
    fireEvent.click(button())
    await waitFor(() => screen.getByRole('alert'))
    assert.equal(screen.getByRole('alert').textContent, DATA_REQUEST_FAILURE_MESSAGE)
  })

  it('cannot fire twice while a request is pending', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    mockFetch(async () => {
      calls += 1
      await gate
      return jsonResponse(201, { status: 'open', requestedAt: '2026-11-15T09:00:00.000Z', responseBy: '2026-12-15T09:00:00.000Z' })
    })
    render(<DataRequestButton />)
    fireEvent.click(button())
    fireEvent.click(button())
    assert.equal(calls, 1)
    assert.equal(button().disabled, true)
    release()
    await waitFor(() => screen.getByRole('status'))
    assert.equal(button().disabled, false)
  })
})
