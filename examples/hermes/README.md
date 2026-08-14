# Hitly plugin for Hermes Agent

Drop-in Hermes plugin. Copy this directory to `~/.hermes/plugins/hitly/`, enable it, and (for dangerous-command routing) select the Hitly approval transport.

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

Kanban block/review cards are created even if the transport is unset. The gateway process polls Hitly and runs `hermes kanban comment` / `unblock` locally.

See [the Hermes integration guide](https://hitly.net/integrations/hermes).
