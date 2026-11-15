/**
 * Typed errors for the Zammad client. None of these carry the API token,
 * request headers, a URL query string, or a raw fetch `cause` — messages only
 * ever reference the method and the URL path (without query string), and the
 * transport error keeps just a sanitized `causeName`/`causeCode`. The leak
 * tests in src/leak.test.ts pin this over the whole error object.
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
 * The fetch call itself threw (DNS, connect, TLS, abort timeout). Never
 * retried: the retry policy is status-code based. The raw error is
 * deliberately NOT attached as `cause` — fetch errors can embed the full URL
 * (including the query string, e.g. search terms); only a sanitized
 * name/code survives here.
 */
export class ZammadTransportError extends Error {
  readonly method: string
  readonly path: string
  readonly causeName: string
  readonly causeCode?: string

  constructor(init: { method: string; path: string; cause?: unknown }) {
    super(`Zammad ${init.method} ${init.path} could not be delivered`)
    this.name = 'ZammadTransportError'
    this.method = init.method
    this.path = init.path
    const cause = init.cause
    this.causeName = cause instanceof Error ? cause.name : typeof cause
    const code = (cause as { code?: unknown } | undefined)?.code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) this.causeCode = code
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
 * Main-entry guard: rawRequest tried to reach a KB answer write path
 * (write methods on .../knowledge_bases/.../answers..., or the
 * publish/internal/archive/unarchive actions). Those live only in the
 * publisher entry point.
 */
export class ZammadKbWriteGuardError extends Error {
  readonly method: string
  readonly path: string

  constructor(init: { method: string; path: string }) {
    super(
      `Refused ${init.method} ${init.path}: the main @hitly/zammad-client entry must not write KB answers or publish. Use @hitly/zammad-client/publisher (execute_approved only).`,
    )
    this.name = 'ZammadKbWriteGuardError'
    this.method = init.method
    this.path = init.path
  }
}

/**
 * Publisher CAS guard: the live KB answer no longer matches the text the
 * caller expected to overwrite (compare-and-swap refusal). Raised before any
 * write.
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

/**
 * Publisher input guard: an approved/expected content hash was not exactly
 * 64 hex characters (after case normalization). Raised BEFORE any network
 * call: empty, truncated and non-hex values are refused, so a malformed hash
 * can never silently skip the compare.
 */
export class ZammadInvalidHashError extends Error {
  readonly field: string

  constructor(init: { field: string }) {
    super(`${init.field} must be exactly 64 hexadecimal characters (a sha256 hex digest)`)
    this.name = 'ZammadInvalidHashError'
    this.field = init.field
  }
}

/**
 * Publisher conflict: the current draft content does not match the content
 * hash approved in HITLy. Typed conflict with HTTP-semantics status 409,
 * raised before any publish call.
 */
export class ZammadConflictError extends Error {
  readonly status = 409 as const
  readonly kbId: number
  readonly answerId: number
  readonly approvedContentHash: string
  readonly actualHash: string

  constructor(init: {
    kbId: number
    answerId: number
    approvedContentHash: string
    actualHash: string
  }) {
    super(
      `Refusing to publish KB answer ${init.answerId} in KB ${init.kbId}: ` +
        `current draft body sha256 ${init.actualHash} does not match the approved content hash ${init.approvedContentHash}.`,
    )
    this.name = 'ZammadConflictError'
    this.kbId = init.kbId
    this.answerId = init.answerId
    this.approvedContentHash = init.approvedContentHash
    this.actualHash = init.actualHash
  }
}
