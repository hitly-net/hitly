Copied unchanged from hitly-net/hitl-spec at a8c4b2e (Apache-2.0), except
`response.schema.json` which is refreshed to 3c2df2d (PR #15, typed-answer
ruling: top-level `answer` is the only carrier when status=answered; no
top-level `value` alongside it):

- `args-hash.json`: examples/vectors/args-hash.json (§3.8 argsHash vectors)
- `event-chain.json`: examples/vectors/event-chain.json (§5.4 event hash chain)
- `response.schema.json`: schemas/v0/response.json (hitl/response/v0)
- `event.schema.json`: schemas/v0/event.json (referenced by the response schema)

Refresh these when the spec changes; the tests in `src/jcs.test.ts` and
`apps/app/lib/hitl-response.test.ts` read them.
