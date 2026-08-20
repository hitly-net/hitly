# Phoenix OTEL Trace Viewer

Arize Phoenix is an open-source observability platform for AI systems. This example demonstrates using Phoenix to view HITL<sub><i>y</i></sub> approval lifecycle traces exported via OpenTelemetry.

## Purpose

This example shows how to:

1. Run Phoenix locally via Docker Compose
2. Configure a HITL<sub><i>y</i></sub> workspace to export OTEL traces
3. View approval lifecycle traces (requested, decided, resumed, resume_failed) in the Phoenix UI

Phoenix provides a visual timeline of approval events with trace IDs, span IDs, and attributes like approval ID, plugin, action name, decision, and policy context.

## Requirements

- Docker and Docker Compose
- Running HITL<sub><i>y</i></sub> instance (see main repo README)

## Setup

### 1. Start Phoenix

```bash
docker compose up -d
```

Phoenix will be available at:
- **UI**: `http://127.0.0.1:6006`
- **OTLP/HTTP endpoint**: `http://127.0.0.1:6006/v1/traces`

### 2. Configure HITL<sub><i>y</i></sub> Workspace

In your HITL<sub><i>y</i></sub> workspace settings (Settings → Workspace → OTEL Endpoints):

1. Click **Add OTEL Endpoint**
2. Set:
   - **Name**: `Phoenix`
   - **Endpoint**: `http://127.0.0.1:6006/v1/traces`
   - **Protocol**: `http/protobuf` (default)
   - **Headers**: (leave blank for local Phoenix)
   - **Enabled**: ✓ (checked)
3. Save

### 3. Test the Integration

1. Create or decide an approval in HITL<sub><i>y</i></sub> at `http://localhost:3001`
2. Open Phoenix UI at `http://127.0.0.1:6006`
3. Navigate to **Traces** in the Phoenix UI
4. You should see traces with:
   - Service name: `hitly`
   - Span names: `hitly.approval.requested`, `hitly.approval.decided`, `hitly.approval.resumed`, or `hitly.approval.resume_failed`
   - Attributes: approval ID, plugin, action name, decision, policy context

## What Gets Exported

HITL<sub><i>y</i></sub> exports OTEL traces for the approval lifecycle:

- **`requested`** - Approval ingested from origin
- **`decided`** - Reviewer approved/rejected/edited
- **`resumed`** - Origin successfully resumed
- **`resume_failed`** - Origin resume failed

Each span includes:

- **Resource attributes**: `service.name=hitly`, `hitly.workspace_id`, `hitly.project_id`
- **Span attributes**: `hitly.approval_id`, `hitly.plugin`, `hitly.action_name`, `hitly.status`, `hitly.decision` (when decided), `hitly.agent_id`, `hitly.system_id`, `hitly.risk_tier`, `hitly.event_type`, `hitly.event_id`

**Note**: Raw `action.args` are **never** exported to OTEL traces. For full evidence payloads, see the [Envelope](/docs/envelope) and [S3](/docs/s3) evidence sinks.

## Architecture

```
HITL<sub><i>y</i></sub> Approval Lifecycle
  ↓
  OTEL Trace Export (fail-open)
  ↓
  Phoenix OTLP/HTTP Endpoint
  ↓
  Phoenix UI (http://127.0.0.1:6006)
```

OTEL trace export is **fail-open**: if Phoenix is down or returns 5xx, HITL<sub><i>y</i></sub> logs the error and continues. Approval ingestion and decision are **never blocked** by OTEL export failures.

## Multiple Endpoints

You can configure multiple OTEL endpoints in the workspace settings. HITL<sub><i>y</i></sub> will fan out traces to all enabled endpoints independently. If one endpoint fails, the others still receive traces.

For example, you might export to:
- Local Phoenix for development
- Honeycomb for production observability
- Grafana Tempo for long-term storage

## Production Considerations

For production use:

1. **Authentication**: Phoenix supports authentication. Set `Authorization` or other headers in the HITL<sub><i>y</i></sub> endpoint config.
2. **Network**: Ensure the HITL<sub><i>y</i></sub> app server can reach the Phoenix endpoint (or your OTEL collector).
3. **Sampling**: Phoenix and most OTEL backends support sampling. HITL<sub><i>y</i></sub> does not sample; it exports every approval lifecycle event.
4. **Encryption**: For network security, use headers with encrypted credentials (HITL<sub><i>y</i></sub> encrypts the `headers` field).
5. **Protocol**: HITL<sub><i>y</i></sub> v1 supports OTLP/HTTP only (`http/protobuf` or `http/json`). gRPC is not supported yet.

## Stopping

```bash
docker compose down
```

## Documentation

- [Arize Phoenix Documentation](https://docs.arize.com/phoenix)
- [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [HITL<sub><i>y</i></sub> Trace Export](/docs/trace)
