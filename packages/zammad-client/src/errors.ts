/**
 * Typed errors for the Zammad client. None of these carry the API token or
 * request headers — messages only ever reference the method and the URL path
 * (without query string) so search terms and secrets stay out of logs.
 */

/** Non-2xx HTTP response from Zammad. Carries the HTTP status code. */
export class ZammadApiError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string

  constructor(init: { method: string; path: string; status: number; statusText?: string }) {
    const statusText = init.statusText ? ` (${init.statusText})` : ''
    super(`Zammad ${init.method} ${init.path} failed with HTTP ${init.status}${statusText}`)
    this.name = 'ZammadApiError'
    this.status = init.status
    this.method = init.method
    this.path = init.path
  }
}

/**
 * The fetch call itself threw (DNS, connect, TLS, abort). Never retried:
 * the retry policy covers HTTP 429 and 5xx responses only.
 */
export class ZammadTransportError extends Error {
  readonly method: string
  readonly path: string

  constructor(init: { method: string; path: string; cause?: unknown }) {
    super(`Zammad ${init.method} ${init.path} could not be delivered`, { cause: init.cause })
    this.name = 'ZammadTransportError'
    this.method = init.method
    this.path = init.path
  }
}

/** 2xx response whose JSON did not have the shape the caller needs. */
export class ZammadResponseShapeError extends Error {
  readonly method: string
  readonly path: string

  constructor(init: { method: string; path: string; detail: string }) {
    super(`Zammad ${init.method} ${init.path} returned an unexpected response shape: ${init.detail}`)
    this.name = 'ZammadResponseShapeError'
    this.method = init.method
    this.path = init.path
  }
}

/**
 * Publisher guard: the live KB answer no longer matches the text the caller
 * expected to overwrite (compare-and-swap refusal). Raised before any write.
 */
export class ZammadHashMismatchError extends Error {
  readonly kbId: number
  readonly answerId: number
  readonly expectedCurrentHash: string
  readonly actualHash: string

  constructor(init: {
    kbId: number
    answerId: number
    expectedCurrentHash: string
    actualHash: string
  }) {
    super(
      `Refusing to overwrite KB answer ${init.answerId} in KB ${init.kbId}: ` +
        `live body sha256 ${init.actualHash} does not match expectedCurrentHash ${init.expectedCurrentHash}. ` +
        `The answer changed since the hash was taken — re-read it and retry.`,
    )
    this.name = 'ZammadHashMismatchError'
    this.kbId = init.kbId
    this.answerId = init.answerId
    this.expectedCurrentHash = init.expectedCurrentHash
    this.actualHash = init.actualHash
  }
}
