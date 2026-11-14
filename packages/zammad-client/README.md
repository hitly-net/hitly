# @hitly/zammad-client

Typed client for the Zammad REST API used by HITLy support. Zammad is
configured out-of-band; this package never ships credentials. All tests run
against a mocked fetch — no live Zammad is ever called.

## Install / use

```ts
import { createZammadClient } from '@hitly/zammad-client'

const zammad = createZammadClient({
  baseUrl: 'https://zammad.example.test',
  token: process.env.ZAMMAD_TOKEN!, // sent as `Authorization: Token token=<token>`
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

The token is only ever placed in the `Authorization` header. It is never
logged and never included in error messages (error messages carry method +
path without the query string).

## Retry policy

- Retried with backoff (0/500/2000 ms + jitter, injectable): HTTP **429** and
  **5xx** only.
- Every other 4xx fails immediately with `ZammadApiError` (typed, carries
  `status`).
- A thrown fetch (DNS/connect) raises `ZammadTransportError` and is NOT
  retried — the retry policy is status-code based by design.

## Entry-point policy: KB publishing

The **main entry has no publish method and no method that edits an existing
KB answer.** It can only create KB answers as *drafts*
(`kbCreateDraftAnswer` — no publish call is ever made).

Publishing and live-answer edits live exclusively in:

```ts
import { createZammadPublisher } from '@hitly/zammad-client/publisher'
```

**POLICY: only `execute_approved` may import
`@hitly/zammad-client/publisher`.** No app, plugin, MCP tool, or support flow
may import it. This is pinned by `src/entry-guards.test.ts` (export surface,
method-name allowlist, and source scans).

`updateLiveAnswer(kbId, answerId, newBody, expectedCurrentHash)` is a
compare-and-swap: it re-reads the live answer body, sha256s it, and throws
`ZammadHashMismatchError` (before any write) unless the live hash equals the
caller-supplied `expectedCurrentHash`. The approval flow must therefore have
seen the exact text it authorises overwriting.

## Support ticket types

Ticket types are defined once in `@hitly/core` as `SUPPORT_TICKET_TYPES`
(billing / account / data / general / feature / bug / security). Adding a
type is one line there.

## Object Manager setup (hitly_type field)

```
ZAMMAD_BASE_URL=https://zammad.example.test ZAMMAD_TOKEN=... \
  yarn tsx packages/zammad-client/scripts/setup-hitly-type-field.ts
```

Idempotent: creates the Ticket select attribute `hitly_type` when absent,
updates its options when they drift from `SUPPORT_TICKET_TYPES`, no-ops when
equal. **After running it, Ops must run the Zammad Object Manager migrate
step** (`bundle exec rails zammad:objects:migrate`) — the script prints this
reminder.

## VERIFY items (no TEST Zammad exists yet)

- `searchTickets` `paginate=false` behaviour and result shape.
- `kbSearch` `posts` bucket shape (`answer`/`ticket` keys).
- `kbCreateDraftAnswer` draft semantics (published_at stays null; default
  locale when `kb_locale_id` omitted).
- `include_contents` parameter id for reading the live answer body
  (translation id vs content id).
- Object Manager GET response shape (array vs id-keyed map — both handled),
  PUT merge semantics, and the exact migrate command.

All sites are marked inline with `// VERIFY against Zammad 7.2 when TEST exists`.

## Out of scope (later PRs)

- The support receiver that turns inbound emails into Zammad tickets (PR-B).
- The `execute_approved` wiring of the publisher entry point (PR-C).
