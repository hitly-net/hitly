# Evidence HTTP Reference Receiver

A simple HTTP server that receives `hitly.evidence.v1` events from Hitly and writes them to disk as JSON files.

## Purpose

This example demonstrates how to implement an HTTP evidence sink endpoint for Hitly. It writes evidence events to a local directory as JSON files for demonstration and development.

In production, you would implement your own receiver that POSTs evidence events to your durable storage system (S3, database, audit log service, etc.).

## Running

```bash
yarn dev
# or
yarn start
```

The server listens on port 3100 by default (configurable via `PORT` env var).

## Configuration

### Environment Variables

- `PORT` - Server port (default: 3100)
- `EVENTS_DIR` - Directory to write evidence files (default: `./events`)

### Hitly Project Settings

In your Hitly project config, set:

- **Evidence Sink Type**: `HTTP`
- **Evidence Sink URL**: `http://localhost:3100/events`
- **Authorization Header**: (optional, for production use)

## How It Works

1. Hitly POSTs evidence events to `/events` with:
   - `Content-Type: application/json`
   - `Idempotency-Key: <event_id>`
   - Full evidence event JSON body

2. This receiver:
   - Writes the event to `./events/<event_id>.json`
   - Returns an `AppendReceipt` with `store_uri` as `file://...`

3. Hitly stores the receipt (not the full event) in its database.

## Evidence Events

Evidence events track the approval lifecycle:

- `requested` - Approval ingested from origin
- `decided` - Reviewer approved/rejected/edited
- `resumed` - Origin successfully resumed
- `resume_failed` - Origin resume failed

Each event includes:
- Origin context (plugin, projectId, runId, stepId)
- Agent/trace context (agentId, traceId, spanId) when available
- System context (systemId, inventoryId)
- Policy context (policyId, riskTier, policyRationale)
- Action (name, args, SHA-256 hashes)
- Oversight (reviewer, decision, timestamp)
- Integrity (event chain via prev_event_id, prev_content_sha256)

## Endpoints

### POST /events
Append an evidence event.

**Request:**
```json
{
  "spec": "hitly.evidence.v1",
  "event_id": "evt_...",
  "approval_id": "apr_...",
  "event_type": "decided",
  "seq": 2,
  "occurred_at": "2024-01-01T00:00:00.000Z",
  "origin": { "plugin": "mastra", "projectId": "...", "runId": "..." },
  "action": { "name": "send_refund", "args": {...}, "proposed_sha256": "..." },
  "oversight": { "reviewer_id": "usr_...", "decision": "accept", "decided_at": "..." },
  "retention": { "min_days": 180 },
  "integrity": {
    "alg": "sha256",
    "prev_event_id": "evt_...",
    "prev_content_sha256": "...",
    "content_sha256": "..."
  }
}
```

**Response:**
```json
{
  "event_id": "evt_...",
  "content_sha256": "...",
  "store_uri": "file:///.../events/evt_....json",
  "stored_at": "2024-01-01T00:00:00.000Z"
}
```

### GET /events/:event_id
Retrieve a stored evidence event.

## Testing

Run the test suite:

```bash
yarn test
```

## Production Considerations

For production use:

1. **Durable Storage**: Replace local file writes with your storage system (S3, database, audit log service)
2. **Authentication**: Validate `Authorization` header
3. **Idempotency**: Check `event_id` to prevent duplicate writes (this example implements basic idempotency)
4. **Integrity**: Verify `content_sha256` matches the received event
5. **Retention**: Honor `retention.min_days` and `retention.expires_at`
6. **Monitoring**: Log all append operations for audit
7. **Fail-closed**: Return 5xx errors when storage is unavailable (Hitly will NOT resume the origin on decided events if the sink fails)
