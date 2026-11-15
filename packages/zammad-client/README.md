# @hitly/zammad-client

Typed client for the Zammad REST API used by HITLy support. Zammad is
configured out-of-band; this package never ships credentials and is
**self-contained** — it imports nothing from other `@hitly` workspace
packages, so it can be lifted into a standalone repo as-is. All tests run
against a mocked fetch — no live Zammad is ever called.

## Install / use

```ts
import { createZammadClient } from '@hitly/zammad-client'

const zammad = createZammadClient({
  baseUrl: 'https://zammad.example.test',
  token: process.env.ZAMMAD_TOKEN!, // constructor config ONLY (see Tokens)
})

const ticket = await zammad.getTicket(123)
await zammad.addPublicEmailReply(123, {
  to: 'customer@example.test',
  subject: 'Re: your invoice',
  body: '<p>...</p>',
  contentType: 'text/html',
})
await zammad.addInternalNote(123, 'ops note')
await zammad.updateTicket(123, { state: 'closed', hitly_type: 'billing' })
const hits = await zammad.searchTickets('state:open hitly_type:billing')
```

## Tokens (per instance)

Every Zammad instance/role gets its **own API token** — e.g. `triage`,
`accounts`, `security`, `finance`, `general`, `librarian`, and a dedicated
`kb-publisher` token. Rules:

- `createZammadClient` and `createZammadPublisher` take the token **only**
  from the constructor config (`{ token }`). They never read any global env
  var (the CLI in `scripts/` reads `ZAMMAD_TOKEN` only at its own boundary
  and passes it into the config).
- The token is sent via the Zammad-expected `Authorization` header shape
  ("Token" scheme with a `token=<value>` pair). It is never logged and never
  included in error objects (message, own props, cause or JSON — pinned by
  `src/leak.test.ts`).
- **The `kb-publisher` token goes ONLY to the publisher entry point**
  (`createZammadPublisher`). Never give it to a main-entry client; never
  give main-entry tokens to the publisher.

## Retry policy (M1)

- HTTP **429** is retried for every method (rate limit => nothing was
  stored), honouring `Retry-After` (seconds or HTTP-date), capped at 30 s,
  else the jittered 0/500/2000 ms schedule.
- HTTP **5xx** is retried only for idempotent requests: GET/PUT/PATCH/DELETE
  and the publish action. **Non-idempotent POSTs** (public email reply,
  internal note, KB draft create, raw POST) are **never re-sent on 5xx** —
  Zammad may already have stored the article.
- Other 4xx fail immediately with `ZammadApiError` (typed, carries `status`).
- Transport failures (incl. the per-request AbortController timeout,
  default 15 s, configurable via `timeoutMs`) raise `ZammadTransportError`
  and are never retried; the raw fetch error is not attached (sanitized
  `causeName`/`causeCode` only). Failed response bodies are cancelled before
  a retry.

## Entry-point policy: KB publishing

The **main entry** has no publish method and no method that edits an
existing KB answer. Its `rawRequest` is **confined**: any write
(POST/PUT/PATCH/DELETE) targeting `.../knowledge_bases/.../answers...` or a
publish/internal/archive/unarchive action is refused with
`ZammadKbWriteGuardError` before any network call. It can only create KB
answers as *drafts* (`kbCreateDraftAnswer` — no publish call is ever made).

Publishing and live-answer edits live exclusively in:

```ts
import { createZammadPublisher } from '@hitly/zammad-client/publisher'
```

**POLICY: only `execute_approved` may import
`@hitly/zammad-client/publisher`.** No app, plugin, MCP tool, or support
flow may import it. The package `exports` map is pinned to exactly `.` and
`./publisher`, the main-entry and publisher export lists are pinned to exact
allowlists, and the `rawRequest` confinement is tested
(`src/entry-guards.test.ts`).

Both publisher write methods are hash-gated, and both hash inputs are
validated as exactly 64 hex chars (case-normalized) BEFORE any network call
(`ZammadInvalidHashError` on empty/truncated/non-hex):

- `updateLiveAnswer(kbId, answerId, newBody, expectedCurrentHash)` —
  re-reads the live body, sha256s it, throws `ZammadHashMismatchError`
  before any write unless it equals `expectedCurrentHash`.
- `publishAnswer(kbId, answerId, approvedContentHash)` — requires the
  content hash approved in HITLy; reads the **current draft** body (the
  answer's `translation_ids[0]` row — never the older published row) and
  throws `ZammadConflictError` (status 409, **no publish call**) unless it
  hashes to `approvedContentHash`.

Note: the compare-then-write sequences are read → compare → write with no
server-side precondition (Zammad has no documented If-Match on these
endpoints), so a concurrent edit between the read and the write is possible
in theory; the hash gates make approver-staleness loud, not atomic. (CAS
race hardening is explicitly out of scope this round.)

## Support ticket types

Defined once in `src/ticket-types.ts` as `SUPPORT_TICKET_TYPES`
(billing / account / data / general / feature / bug / security), with the
derived `SupportTicketType` and `isSupportTicketType`. Adding a type is one
line there.

## Object Manager setup (hitly_type field)

```
ZAMMAD_BASE_URL=https://zammad.example.test ZAMMAD_TOKEN=... \
  yarn tsx packages/zammad-client/scripts/setup-hitly-type-field.ts
```

Idempotent: creates the Ticket select attribute `hitly_type` when absent,
sends a **complete** PUT record when the options (keys or labels) drift or
the existing attribute is not a select, no-ops when everything matches.
**After any change, Ops must run the Zammad Object Manager migrate step**
(`bundle exec rails zammad:objects:migrate`) — the script prints this
reminder.

## VERIFY items (no TEST Zammad exists yet)

- `searchTickets` `paginate=false` behaviour and result shape.
- `kbSearch` `posts` bucket shape (`answer`/`ticket` keys).
- `kbCreateDraftAnswer` draft semantics (published_at stays null; default
  locale when `kb_locale_id` omitted).
- Publisher `readLiveBody`: the `include_contents` parameter id
  (translation id vs content id).
- Draft-translation identification (`translation_ids[0]`).
- Object Manager GET response shape (array vs id-keyed map — both handled),
  PUT merge semantics, and the exact migrate command.

All sites are marked inline with `// VERIFY against Zammad 7.2 when TEST exists`.

## Out of scope (later PRs)

- The support receiver that turns inbound emails into Zammad tickets (PR-B).
- The `execute_approved` wiring of the publisher entry point (PR-C),
  including the repo-wide import scan for publisher usage.
