# @hitly/plugin-hermes

Hermes Agent adapter for HITLy: ingest command-approval or kanban block/review payloads with a `resumeUrl`. Resume POSTs the decision JSON to the origin's callback URL.

The drop-in Hermes plugin ([examples/hermes](../../examples/hermes)) starts a local webhook listener and waits on the callback. Same pattern as HTTP: `{ decision, id, metadata }`.

## Resume callback

`resumeUrl` is required for resume. If missing, resume fails with an error. The origin should wait on the callback, not poll HITLy.

The `resumeUrl` must be reachable from the HITLy process. Same-machine OSS deployments work fine (`127.0.0.1`). Cloud HITLy cannot reach a laptop `localhost` unless you use a tunnel (ngrok, Tailscale Funnel, etc.).
