import { NextResponse } from 'next/server'
import { VERIFY_TOKEN_SECRET_HEADER } from '../../mcp/src/oauth.ts'
import { isWellFormedDelegatedToken } from './keys'
import {
  applyFailedAuthLimit,
  applyRestLimit,
  clientAddressRestSubject,
  hashRestSubject,
  type RestLimitAcquire,
} from './rest-limit'

/**
 * POST /api/v1/mcp/verify-token — the HITLy MCP edge asks here before it
 * accepts a delegated marketplace token, and forwards the bearer verbatim
 * on subsequent calls (the host-side resolution runs through the edition
 * seam on those requests).
 *
 * Contract (MCP side mirrors this in apps/mcp/src/oauth.ts):
 *  - the token is presented ONLY in `Authorization: Bearer <jwt>` — never a
 *    request body;
 *  - the caller authenticates with `x-hitly-mcp-secret` (shared secret
 *    HITLY_MCP_VERIFY_TOKEN_SECRET, set on both the host and the MCP edge);
 *    503 fail-closed until it is configured;
 *  - success is exactly 200 + `{ ok: true }`; anything else the edge treats
 *    as rejection, so a proxy or stub answering bare 200 never approves;
 *  - budgets key on the CALLER (secret + address), never on the presented
 *    token — rotating throwaway tokens cannot mint fresh budgets. Bad caller
 *    secrets count per client address in `failed-auth`.
 */

export interface McpVerifyTokenDeps {
  /** Shared secret from env; route passes HITLY_MCP_VERIFY_TOKEN_SECRET. */
  callerSecret?: string
  /** The real delegated-token check, delegated with the original request. */
  delegate: (request: Request) => Promise<Response>
  acquire?: RestLimitAcquire
  failedAcquire?: RestLimitAcquire
  log?: (event: Record<string, unknown>) => void
}

export function handleMcpVerifyTokenFactory(deps: McpVerifyTokenDeps) {
  const secret = deps.callerSecret?.trim() || undefined
  return async function handleMcpVerifyTokenPost(request: Request): Promise<Response> {
    if (!secret) {
      // Not configured is not "open": without a caller secret, verification
      // is disabled rather than unauthenticated.
      deps.log?.({ route: 'mcp.verify_token', outcome: 'host_not_configured' })
      return NextResponse.json({ error: 'not_configured' }, { status: 503 })
    }

    const caller = request.headers.get(VERIFY_TOKEN_SECRET_HEADER) ?? ''
    if (!callerEquals(caller, secret)) {
      deps.log?.({ route: 'mcp.verify_token', outcome: 'unauthorized_caller' })
      const limited = await applyFailedAuthLimit(request, deps.failedAcquire)
      if (limited) return limited
      return NextResponse.json({ error: 'unauthorized_caller' }, { status: 401 })
    }

    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    // Single choke point (lib/keys): the same gate the MCP edge and the
    // session/API-key classification paths use, so the halves cannot drift.
    if (!isWellFormedDelegatedToken(token)) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
    }

    // Per-caller budget on a subject stable for the deployment — never the
    // presented token.
    const subject = hashRestSubject(`mcp-verify\0${clientAddressRestSubject(request.headers)}`)
    const limited = await applyRestLimit('mcp-verify', subject, deps.acquire)
    if (limited) return limited

    const response = await deps.delegate(request)
    deps.log?.({ route: 'mcp.verify_token', outcome: response.ok ? 'accepted' : 'rejected', status: response.status })
    return response
  }
}

/** Constant-time compare without a dependency: XOR-accumulate over equalised lengths. */
function callerEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
