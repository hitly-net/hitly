/**
 * Answer gating for `reasonRequired` (hitl-spec 3.6) and `mustOpen` (hitl-spec 3.7).
 *
 * Shared by the reviewer client (validate before submit) and the host (re-validate on
 * submit and at request ingest). Field names follow the spec: `reasonRequired`,
 * `mustOpen`, `ref`. Pure functions only — no DB and no UI imports, so both sides can
 * call the exact same rules.
 */

import type { ApprovalEnvelope, AllowedActions } from './index.ts'

export interface ContextItemRef {
  /** Gating key: the item's declared `ref`, else its url (links) or name+url (attachments). */
  ref: string
  kind: 'link' | 'attachment'
  label: string
  /** An item is only gateable when it has an openable source. Items without a url cannot be opened, so they gate nothing. */
  url?: string
  mustOpen: boolean
}

export interface FieldError {
  /** Field pointer for the error, per hitl-spec 7 (for example `reason` or `context.items.<ref>`). */
  field: string
  message: string
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * True when only the binary pair is answerable (accept and reject allowed, edit and
 * respond not). Per spec 3.6 a binary request defaults `reasonRequired` to `["reject"]`
 * when it is absent, and that default only applies to binary-shaped requests.
 */
export function isBinaryLikeRequest(envelope: Pick<ApprovalEnvelope, 'allowedActions'>): boolean {
  const allowed: AllowedActions | undefined = envelope.allowedActions
  if (!allowed) return false
  return allowed.accept === true && allowed.reject === true && allowed.edit !== true && allowed.respond !== true
}

/**
 * The answer values that trigger a required reason (spec 3.6).
 *
 * A declared `reasonRequired` wins (invalid entries are rejected at ingest, see
 * `validateRequestGating`). When absent, binary-like requests default to `['reject']`;
 * every other request type defaults to no required reasons.
 */
export function resolveReasonRequired(
  envelope: Pick<ApprovalEnvelope, 'allowedActions' | 'reasonRequired'>,
): string[] {
  if (Array.isArray(envelope.reasonRequired)) {
    const out: string[] = []
    for (const value of envelope.reasonRequired) {
      const entry = trimmed(value)
      if (entry && !out.includes(entry)) out.push(entry)
    }
    return out
  }
  return isBinaryLikeRequest(envelope) ? ['reject'] : []
}

/** True when choosing `decision` as the answer triggers a required reason (spec 3.6). */
export function requiresReason(
  envelope: Pick<ApprovalEnvelope, 'allowedActions' | 'reasonRequired'>,
  decision: string,
): boolean {
  return resolveReasonRequired(envelope).includes(decision)
}

/**
 * Declared context items of one request (spec 3.7), links first then attachments.
 * Only items with an openable `url` are returned: an item with no url cannot be
 * opened, so it must not gate the answer. `ref` keys are unique within a request
 * (checked at ingest); derived keys can collide and are handled by the caller.
 */
export function contextItems(
  envelope: Pick<ApprovalEnvelope, 'externalUrls' | 'attachments'>,
): ContextItemRef[] {
  const items: ContextItemRef[] = []
  for (const link of envelope.externalUrls ?? []) {
    const url = trimmed(link.url)
    if (!url) continue
    const ref = trimmed(link.ref) || url
    items.push({ ref, kind: 'link', label: trimmed(link.label) || url, url, mustOpen: link.mustOpen === true })
  }
  for (const file of envelope.attachments ?? []) {
    const name = trimmed(file.name)
    const url = trimmed(file.url)
    if (!name || !url) continue
    const ref = trimmed(file.ref) || `${name}:${url}`
    items.push({ ref, kind: 'attachment', label: name, url, mustOpen: file.mustOpen === true })
  }
  return items
}

/** Context items that gate the answer until opened (`mustOpen: true` with an openable url). */
export function mustOpenItems(
  envelope: Pick<ApprovalEnvelope, 'externalUrls' | 'attachments'>,
): ContextItemRef[] {
  return contextItems(envelope).filter((item) => item.mustOpen)
}

/** Find a declared context item by its gating key (ref) or by its raw url. */
export function findContextItem(
  envelope: Pick<ApprovalEnvelope, 'externalUrls' | 'attachments'>,
  refOrUrl: string,
): ContextItemRef | undefined {
  const key = trimmed(refOrUrl)
  return contextItems(envelope).find((item) => item.ref === key || item.url === key)
}

/**
 * Gating items this reviewer has not opened yet. `openedRefs` are the gating keys
 * with a recorded `openedAt` for this reviewer (spec 4.3 `activity.items[].openedAt`).
 */
export function unopenedMustOpenItems(
  envelope: Pick<ApprovalEnvelope, 'externalUrls' | 'attachments'>,
  openedRefs: string[],
): ContextItemRef[] {
  const opened = new Set(openedRefs)
  return mustOpenItems(envelope).filter((item) => !opened.has(item.ref))
}

/**
 * Validate one submitted answer against the request's rules (spec 7, at answer
 * submission): required reason per 3.6 and `mustOpen` gating per 3.7. Returns field
 * errors identifying each failing field; an empty array means the submission is valid.
 *
 * `openedRefs` must be the opens recorded for the reviewer who is submitting.
 */
export function validateAnswerSubmission(args: {
  envelope: Pick<ApprovalEnvelope, 'allowedActions' | 'reasonRequired' | 'externalUrls' | 'attachments'>
  decision: string
  reason?: string
  openedRefs: string[]
}): FieldError[] {
  const errors: FieldError[] = []
  if (requiresReason(args.envelope, args.decision) && !trimmed(args.reason)) {
    errors.push({ field: 'reason', message: 'A reason is required for this answer.' })
  }
  for (const item of unopenedMustOpenItems(args.envelope, args.openedRefs)) {
    errors.push({
      field: `context.items.${item.ref}`,
      message: `"${item.label}" must be opened before you can answer.`,
    })
  }
  return errors
}

/**
 * Validate an incoming request against the ingest rules a schema cannot express
 * (spec 7, at request ingest): `reasonRequired` entries must be allowed answer
 * values, and context refs must be unique across links and attachments (spec 3.7).
 */
export function validateRequestGating(envelope: ApprovalEnvelope): FieldError[] {
  const errors: FieldError[] = []

  if (Array.isArray(envelope.reasonRequired)) {
    for (const value of envelope.reasonRequired) {
      const entry = trimmed(value)
      const allowedValues = envelope.allowedActions as Record<string, boolean | undefined>
      if (!entry || allowedValues[entry] !== true) {
        errors.push({
          field: 'reasonRequired',
          message: `reasonRequired entry "${entry}" is not an allowed answer value.`,
        })
      }
    }
  }

  const seen = new Set<string>()
  const seenUrls = new Set<string>()
  for (const item of contextItems(envelope)) {
    // One error per duplicate item: a colliding ref that is also a duplicated url is
    // reported once, with the more precise url message (spec 3.7 uniqueness).
    if (item.url && item.ref === item.url && seenUrls.has(item.url)) {
      // Same https URL declared twice with no refs: refs derived from the url collide.
      errors.push({
        field: `context.items.${item.ref}`,
        message: `Context url "${item.url}" is declared more than once; give each item a unique ref.`,
      })
    } else if (seen.has(item.ref)) {
      errors.push({
        field: `context.items.${item.ref}`,
        message: `Context ref "${item.ref}" is not unique across links and attachments.`,
      })
    }
    seen.add(item.ref)
    if (item.url) seenUrls.add(item.url)
  }

  return errors
}
