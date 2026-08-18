# Evidence HTTP Reference Receiver

A simple HTTP server that receives `hitly.evidence.v1` events from HITLy and writes them to disk as JSON files.

## Purpose

This example demonstrates how to implement an HTTP evidence sink endpoint for HITLy. It writes evidence events to a local directory as JSON files and provides a browser UI to view events, approval chains, and integrity proofs.

In production, you would implement your own receiver that POSTs evidence events to your durable storage system (database, audit log service, etc.) and serves them via HTTP(S) deep links.

## Running

```bash
yarn dev
# or
yarn start
```

The server listens on port 3100 by default (configurable via `PORT` env var).

Open `http://localhost:3100` in your browser to see all events stored in this evidence sink.

**Note:** This example does not enforce project separation. If two HITLy projects point at the same store URL, their events will mix. That is expected. HITLy controls which sink URL each project uses.

## Configuration

### Environment Variables

- `PORT` - Server port (default: 3100)
- `EVENTS_DIR` - Directory to write evidence files (default: `./events`)
- `PUBLIC_BASE_URL` - Base URL for store_uri (e.g., `https://evidence.example.com`). If not set, derives from request headers.

### HITLy Project Settings

In your HITLy project config, set:

- **Evidence Sink Type**: `HTTP`
- **Evidence Sink URL**: `http://localhost:3100/events`
- **Authorization Header**: (optional, for production use)

## How It Works

1. HITLy POSTs evidence events to `/events` with:
   - `Content-Type: application/json`
   - `Idempotency-Key: <event_id>`
   - Full evidence event JSON body

2. This receiver:
   - Writes the event to `./events/<event_id>.json`
   - Returns an `AppendReceipt` with `store_uri` as an HTTP(S) deep link (e.g., `http://localhost:3100/events/<event_id>`)

3. HITLy stores the receipt (not the full event) in its database.

4. Users can open the `store_uri` in their browser to view the evidence event, the full approval chain, and integrity proofs.

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
  "store_uri": "http://localhost:3100/events/evt_...",
  "stored_at": "2024-01-01T00:00:00.000Z"
}
```

### GET /events/:event_id
Retrieve a stored evidence event.

- **Accept: application/json** - Returns the raw event JSON
- **Accept: text/html** (browser) - Returns an HTML page showing the event details, including origin, action, oversight decision, integrity hashes, and retention policy

### GET /a/:approval_id
View the complete evidence chain for an approval.

Returns an HTML page showing all events for the specified approval ID in sequence, with prev_event_id and prev_content_sha256 matching the previous event. Ping events are excluded from the chain.

### GET /
List events with optional filters via query params:

- `?event_id=evt_...` - Filter by event ID
- `?approval_id=apr_...` - Filter by approval ID  
- `?event_type=decided` - Filter by event type
- `?runId=run_...` - Filter by origin runId
- `?projectId=prj_...` (optional) - Filter by origin projectId

Returns an HTML page showing matching events. Ping events are excluded from the list.

## Testing

Run the test suite:

```bash
yarn test
```

## Production Considerations

For production use:

1. **Durable Storage**: Replace local file writes with your storage system (database, audit log service)
2. **HTTP(S) Deep Links**: Ensure `store_uri` is a publicly accessible HTTP(S) URL that returns the event in both JSON and HTML formats
3. **Authentication**: Validate `Authorization` header for POST requests; consider read-only public access for GET requests with event_id
4. **Idempotency**: Check `event_id` to prevent duplicate writes (this example implements basic idempotency)
5. **Integrity**: Verify `content_sha256` matches the received event
6. **Retention**: Honor `retention.min_days` and `retention.expires_at`; return 404 after expiration
7. **Monitoring**: Log all append operations for audit
8. **Fail-closed**: Return 5xx errors when storage is unavailable (HITLy will NOT resume the origin on decided events if the sink fails)

## Browser UI

This example includes a simple browser interface:

- **Event page** (`/events/:event_id`) - Shows event details, action, oversight decision, integrity chain, and retention policy
- **Approval chain** (`/a/:approval_id`) - Shows the complete event sequence for one approval with hash chain verification
- **Recent approvals** (`/`) - Lists all approvals stored in this sink

Open the `store_uri` link from the HITLy approval detail page to view the evidence receipt in your browser.
