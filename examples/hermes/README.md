# HITLy plugin for Hermes Agent

Drop-in Hermes plugin. Copy this directory to `~/.hermes/plugins/hitly/`, enable it, and (for dangerous-command routing) select the HITLy approval transport.

```bash
cp -R examples/hermes ~/.hermes/plugins/hitly
hermes plugins enable hitly
```

```yaml
plugins:
  enabled: [hitly]
  entries:
    hitly:
      settings:
        api_url: http://localhost:3001
        api_key: hitly_...
        project_id: prj_...
security:
  approval:
    transport: hitly
    transport_fallback: deny
```

## How it works

### Command approvals

The plugin starts a local webhook server on `127.0.0.1` (random port) when needed. It POSTs the command + `resumeUrl` to HITLy, then waits on the callback (not polling). HITLy POSTs `{ decision, id, metadata }` to the `resumeUrl` when you decide.

### Kanban block/review

Kanban cards are created even if the transport is unset. The gateway process polls the local callback responses and runs `hermes kanban comment` / `unblock` locally.

## Resume callback requirements

The `resumeUrl` must be reachable from the HITLy process. Same-machine OSS deployments work fine (`127.0.0.1`). Cloud HITLy cannot reach a laptop `localhost` unless you use a tunnel (ngrok, Tailscale Funnel, etc.).

See [the Hermes integration guide](https://hitly.net/integrations/hermes).
