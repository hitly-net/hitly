/**
 * Idempotent setup of the Zammad support ticket type field.
 *
 * Creates (or updates) the Ticket select attribute `hitly_type` via the
 * Zammad Object Manager API, with options derived from SUPPORT_TICKET_TYPES
 * in src/ticket-types.ts — adding a ticket type is one line there, then
 * re-running this script syncs Zammad. (The package is self-contained: no
 * imports from other @hitly workspace packages.)
 *
 * Run against a Zammad instance (NEVER in unit tests — tests inject fetch):
 *   ZAMMAD_BASE_URL=https://zammad.example.test ZAMMAD_TOKEN=... \
 *     yarn tsx packages/zammad-client/scripts/setup-hitly-type-field.ts
 *
 * Object Manager API paths:
 *   GET  /api/v1/object_manager_attributes?object=Ticket
 *   POST /api/v1/object_manager_attributes
 *   PUT  /api/v1/object_manager_attributes/{id}  (complete attribute record)
 * // VERIFY against Zammad 7.2 when TEST exists (response shape, PUT merge semantics)
 */
import { pathToFileURL } from 'node:url'
import { createZammadClient, type ZammadClient } from '../src/client.ts'
import { SUPPORT_TICKET_TYPES, supportTicketTypeOptions } from '../src/ticket-types.ts'
import type { ZammadObjectManagerAttribute } from '../src/types.ts'

export const HITLY_TYPE_ATTRIBUTE = 'hitly_type'
export const HITLY_TYPE_DISPLAY = 'HITLy Type'

/** `{ billing: 'Billing', ... }` — Zammad select attribute options map. */
export function hitlyTypeOptions(): Record<string, string> {
  return supportTicketTypeOptions()
}

type SetupLogger = (message: string) => void

function normaliseAttributes(raw: unknown): ZammadObjectManagerAttribute[] {
  // The Object Manager index endpoint has been seen both as a JSON array and
  // as an id-keyed object depending on version.
  // // VERIFY against Zammad 7.2 when TEST exists
  if (Array.isArray(raw)) return raw as ZammadObjectManagerAttribute[]
  if (raw && typeof raw === 'object') return Object.values(raw as Record<string, ZammadObjectManagerAttribute>)
  return []
}

/**
 * Exact option-set equality — keys AND labels (so a label-only change IS a
 * change and triggers a PUT).
 */
function sameOptions(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key, i) => key === bKeys[i] && a[key] === b[key])
}

/** The COMPLETE attribute record we require in Zammad. */
function desiredRecord(options: Record<string, string>) {
  return {
    object: 'Ticket',
    name: HITLY_TYPE_ATTRIBUTE,
    display: HITLY_TYPE_DISPLAY,
    data_type: 'select',
    active: true,
    position: 999, // append after the stock attributes
    options,
  }
}

export type SetupOutcome = 'created' | 'updated' | 'unchanged'

/**
 * Ensure the `hitly_type` select attribute exists on Ticket with the current
 * SUPPORT_TICKET_TYPES options. Idempotent: create when absent; update (with
 * a COMPLETE PUT record) when the option set (keys or labels) differs or the
 * existing attribute is not a select; no-op when everything already matches.
 */
export async function ensureHitlyTypeField(
  client: ZammadClient,
  log: SetupLogger = (message) => console.log(message),
): Promise<SetupOutcome> {
  const raw = await client.rawRequest<unknown>('GET', '/api/v1/object_manager_attributes?object=Ticket')
  const attributes = normaliseAttributes(raw)
  const existing = attributes.find(
    (attr) => attr?.name === HITLY_TYPE_ATTRIBUTE && (attr.object === undefined || attr.object === 'Ticket'),
  )
  const options = hitlyTypeOptions()
  const desired = desiredRecord(options)

  let outcome: SetupOutcome
  if (!existing) {
    await client.rawRequest('POST', '/api/v1/object_manager_attributes', desired)
    log(`created Ticket attribute '${HITLY_TYPE_ATTRIBUTE}' (${HITLY_TYPE_DISPLAY}) with ${Object.keys(options).length} options`)
    outcome = 'created'
  } else {
    const optionsDrift = !sameOptions(existing.options, options)
    const typeDrift = existing.data_type !== undefined && existing.data_type !== 'select'
    if (optionsDrift || typeDrift) {
      // COMPLETE PUT: Zammad replaces the attribute definition, so send the
      // full record (object/name/display/data_type/active/position/options),
      // not just the diff.
      // // VERIFY against Zammad 7.2 when TEST exists (PUT merge semantics)
      await client.rawRequest('PUT', `/api/v1/object_manager_attributes/${existing.id}`, desired)
      log(
        `updated '${HITLY_TYPE_ATTRIBUTE}' to match SUPPORT_TICKET_TYPES ` +
          `(${Object.keys(options).length} options${typeDrift ? '; data_type corrected to select' : ''})`,
      )
      outcome = 'updated'
    } else {
      log(`'${HITLY_TYPE_ATTRIBUTE}' already has the current options — nothing to do`)
      outcome = 'unchanged'
    }
  }

  // Object Manager changes only become effective after Zammad's migrate step.
  log(
    'NOTE FOR OPS: run the Zammad Object Manager migrate step so the change ' +
      'takes effect (bundle exec rails zammad:objects:migrate). ' +
      '// VERIFY the exact migrate command against Zammad 7.2 when TEST exists.',
  )
  return outcome
}

/** CLI entry: only runs when executed directly (not when imported by tests). */
async function main(): Promise<void> {
  const baseUrl = process.env.ZAMMAD_BASE_URL
  const token = process.env.ZAMMAD_TOKEN
  if (!baseUrl || !token) {
    console.error('Set ZAMMAD_BASE_URL and ZAMMAD_TOKEN (API token) in the environment.')
    process.exitCode = 1
    return
  }
  // Token is read from the environment ONLY here, at the CLI boundary, and
  // passed into the client constructor config.
  const client = createZammadClient({ baseUrl, token })
  const outcome = await ensureHitlyTypeField(client)
  console.log(`hitly_type setup: ${outcome}`)
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  await main()
}
