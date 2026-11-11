# HITL spec (vendored fixtures)

## Purpose

`hitl-spec` is the wire-format specification for HITLy's approval/answer
protocol: the `hitl/response/v0` decision document, its event schema, and
the hashing rules that make decision records tamper-evident. The spec itself
is authored in a separate repository (`hitly-net/hitl-spec`, Apache-2.0).
This repo vendors the subset the tests and implementations consume, so the
code and its conformance vectors move together.

## Where it lives

- `packages/core/src/fixtures/hitl-spec/` - the vendored copy:
  - `args-hash.json` - argsHash test vectors (spec section 3.8),
  - `event-chain.json` - event hash-chain vectors (spec section 5.4),
  - `response.schema.json` - the `hitl/response/v0` JSON Schema,
  - `event.schema.json` - the event schema referenced by the response schema,
  - `README.md` - which spec commits the files were copied from and the
    refresh rule (refresh when the spec changes).
- `packages/core/src/jcs.ts` - RFC 8785-style JSON Canonicalization used to
  hash args and chain events exactly as the spec requires.
- `packages/core/src/answer-schema.ts`, `answer-gates.ts` - typed answers
  (`answer {kind, value}`) and the rules that gate them; tests read the
  vendored fixtures.
- `apps/app/lib/hitl-response.ts` - builds the `hitl/response/v0` document
  the host returns; its tests also read the fixtures.
- `apps/mcp/src/jcs.ts`, `answer-types.ts` - the MCP server's mirror, so
  `get_decision` output matches the spec document shape.

## Key interfaces

- `GET decision` output (MCP `get_decision`, host reads): a
  `hitl/response/v0` document - `status` in `pending | answered | declined |
  cancelled | expired`, optional `editedArgs`, and exactly one typed
  `answer` when status is `answered` (the typed-answer ruling from the spec:
  no top-level `value` alongside `answer`).
- `argsHash`: deterministic hash over canonicalized action args (used for
  edit detection and event binding).
- Event hash chain: each recorded event links to the previous hash, making
  the decision trail append-only and verifiable.

## How it talks to the others

- `packages/core` exposes the validators/hashers; `apps/app` and `apps/mcp`
  consume them. The fixtures are test inputs for `packages/core/src/jcs.test.ts`,
  the answer-gates tests, and `apps/app/lib/hitl-response.test.ts`.
- Evidence records (`hitly.evidence.v1`, `packages/core/src/evidence.ts`)
  sit alongside the spec: the spec defines the decision document; the
  evidence types define the audit envelopes around it.

## Configuration

None - it is a static contract plus pure functions.

## Unconfirmed

- Anything defined in `hitly-net/hitl-spec` beyond the four vendored files
  and the copied-README notes (other sections, future versions) cannot be
  confirmed from this repository alone.
