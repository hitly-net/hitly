/**
 * Unverified-email gate (GA hardening).
 *
 * While HITLY_REQUIRE_VERIFIED_EMAIL is on, a user whose address is not
 * verified can still sign in, but:
 *  - creating projects or project API keys is refused, enforced inside the
 *    shared create helpers in lib/project-create.ts — the only server-side
 *    path that writes the projects and projectApiKeys tables, so web server
 *    actions and any present or future REST /api/v1 or MCP create path all
 *    pass through it;
 *  - work-item notifications (decision email and push) are suppressed for
 *    the unverified recipient (lib/notify.ts).
 *
 * Security and account emails (verification, resend, password reset, email
 * change) never pass through this gate and are always sent.
 *
 * The flag defaults OFF (closed beta does not block); GA turns it on via
 * the environment variable. It is read per call so deployments flip it
 * without code changes and tests can toggle it.
 */

import { NextResponse } from 'next/server'

/** Stable machine-readable code for the refusal (API contract). */
export const EMAIL_NOT_VERIFIED_CODE = 'email_not_verified'

/** User-facing instruction; it never leaks another account's state. */
export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Verify your email address to create projects and API keys and to receive notifications. Check your inbox for the verification link, or resend it from the banner at the top of the app.'

/** Headline of the web state shown when a gated action is refused. */
export const VERIFY_TO_CONTINUE_TITLE = 'Verify your email to continue'

/**
 * Typed result a server action returns when the gate blocks the create:
 * never a throw, so the web app renders a clear state instead of an error
 * page or a 500. Serialisable by construction.
 */
export type GateBlockedResult = {
  status: 'error'
  code: typeof EMAIL_NOT_VERIFIED_CODE
  message: string
}

export function gateBlockedResult(message: string = EMAIL_NOT_VERIFIED_MESSAGE): GateBlockedResult {
  return { status: 'error', code: EMAIL_NOT_VERIFIED_CODE, message }
}

export function isGateBlockedResult(value: unknown): value is GateBlockedResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'error' &&
    (value as { code?: unknown }).code === EMAIL_NOT_VERIFIED_CODE
  )
}

/**
 * Maps a thrown value onto the typed result. Returns null for anything that
 * is not the gate error, so the caller rethrows normal failures unchanged
 * (including Next's redirect control-flow throw).
 */
export function toGateBlockedResult(error: unknown): GateBlockedResult | null {
  return error instanceof VerifiedEmailRequiredError ? gateBlockedResult() : null
}

export class VerifiedEmailRequiredError extends Error {
  readonly code = EMAIL_NOT_VERIFIED_CODE
  constructor() {
    super(`${EMAIL_NOT_VERIFIED_CODE}: ${EMAIL_NOT_VERIFIED_MESSAGE}`)
    this.name = 'VerifiedEmailRequiredError'
  }
}

/**
 * Off unless explicitly on. The raw value is trimmed and lowercased before
 * comparison, so `TRUE`, `1 `, `On`, `yes` (any case/surrounding space) all
 * enable the gate; unset and anything else leave it off.
 */
const ON_VALUES = ['1', 'true', 'yes', 'on']

export function requireVerifiedEmailGateEnabled(): boolean {
  const value = (process.env.HITLY_REQUIRE_VERIFIED_EMAIL ?? '').trim().toLowerCase()
  return ON_VALUES.includes(value)
}

/**
 * Throws VerifiedEmailRequiredError when the gate is on and the acting
 * address is unverified. Callers pass the CURRENT stored flag, not a
 * session-cached copy, so verification takes effect immediately.
 */
export function assertEmailVerifiedForCreate(emailVerified: boolean) {
  if (requireVerifiedEmailGateEnabled() && !emailVerified) {
    throw new VerifiedEmailRequiredError()
  }
}

/** REST refusal body for create endpoints: stable code + user instruction. */
export function emailNotVerifiedResponse() {
  return NextResponse.json(
    { error: EMAIL_NOT_VERIFIED_CODE, message: EMAIL_NOT_VERIFIED_MESSAGE },
    { status: 403 },
  )
}

/** Web banner over the signed-in app shell: shown only when gated and unverified. */
export function shouldShowUnverifiedEmailBanner(args: {
  flagEnabled: boolean
  emailVerified: boolean
}): boolean {
  return args.flagEnabled && !args.emailVerified
}
