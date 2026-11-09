Copied unchanged from hitly-net/hitl-spec at a8c4b2e (Apache-2.0):

- `args-hash.json`: examples/vectors/args-hash.json (§3.8 argsHash vectors)
- `event-chain.json`: examples/vectors/event-chain.json (§5.4 event hash chain)
- `response.schema.json`: schemas/v0/response.json (hitl/response/v0)
- `event.schema.json`: schemas/v0/event.json (referenced by the response schema)

Refresh these when the spec changes; the tests in `src/jcs.test.ts` and
`apps/app/lib/hitl-response.test.ts` read them.
