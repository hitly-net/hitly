import { createServer } from 'node:http'
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Server, IncomingMessage } from 'node:http'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100

async function ensureEventsDir(dir: string) {
  try {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
  } catch (error) {
    throw new Error(`Failed to create events directory: ${error instanceof Error ? error.message : 'unknown'}`)
  }
}

interface EvidenceEvent {
  event_id: string
  approval_id: string
  event_type: string
  seq: number
  occurred_at: string
  integrity: {
    content_sha256: string
    prev_event_id?: string
    prev_content_sha256?: string
  }
  origin?: {
    plugin?: string
    projectId?: string
    runId?: string
    stepId?: string
  }
  action?: {
    name?: string
    args?: unknown
    proposed_sha256?: string
    delta?: unknown
    final_sha256?: string
  }
  oversight?: {
    reviewer_id?: string
    decision?: string
    decided_at?: string
    response?: string
    edit_reason?: string
    edit_reason_text?: string
  }
  retention?: {
    min_days?: number
    expires_at?: string
  }
}

interface AppendReceipt {
  event_id: string
  content_sha256: string
  store_uri: string
  stored_at: string
}

function deriveBaseUrl(req: IncomingMessage): string {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL
  if (publicBaseUrl) {
    return publicBaseUrl.replace(/\/$/, '')
  }
  
  const host = req.headers.host || 'localhost:3100'
  const proto = req.headers['x-forwarded-proto'] === 'https' || req.connection.encrypted ? 'https' : 'http'
  return `${proto}://${host}`
}

function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept || ''
  return accept.includes('text/html')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderEventHtml(event: EvidenceEvent, baseUrl: string): string {
  const title = `Evidence Event: ${event.event_id}`
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      line-height: 1.6; 
      max-width: 900px; 
      margin: 2rem auto; 
      padding: 0 1rem;
      background: #18181b;
      color: #fafafa;
    }
    .header { margin-bottom: 2rem; }
    .wordmark { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    .wordmark .sub { font-style: italic; font-size: 0.65em; line-height: 1; }
    .card { 
      background: #27272a; 
      border: 1px solid #3f3f46; 
      border-radius: 0.5rem; 
      padding: 1.5rem; 
      margin-bottom: 1.5rem;
      color: inherit;
    }
    .label { color: #a1a1aa; font-size: 0.875rem; margin-bottom: 0.25rem; }
    .value { font-weight: 500; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.875rem; word-break: break-all; }
    .grid { display: grid; gap: 1rem; }
    @media (min-width: 640px) {
      .grid { grid-template-columns: repeat(2, 1fr); }
      .grid .full { grid-column: 1 / -1; }
    }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code, pre { 
      background: #18181b; 
      border: 1px solid #3f3f46; 
      border-radius: 0.25rem; 
      padding: 0.125rem 0.375rem;
      font-size: 0.875rem;
      color: #fafafa;
    }
    pre { padding: 1rem; overflow: auto; }
  </style>
</head>
<body>
  <div class="header">
    <div class="wordmark">HITL<sub class="sub">y</sub></div>
    <p class="label">Evidence Event</p>
  </div>

  <div class="card">
    <div class="grid">
      <div>
        <div class="label">Event ID</div>
        <div class="value mono">${escapeHtml(event.event_id)}</div>
      </div>
      <div>
        <div class="label">Approval ID</div>
        <div class="value mono"><a href="${escapeHtml(baseUrl)}/a/${escapeHtml(event.approval_id)}">${escapeHtml(event.approval_id)}</a></div>
      </div>
      <div>
        <div class="label">Event Type</div>
        <div class="value">${escapeHtml(event.event_type)}</div>
      </div>
      <div>
        <div class="label">Sequence</div>
        <div class="value">${event.seq}</div>
      </div>
      <div class="full">
        <div class="label">Occurred At</div>
        <div class="value mono">${escapeHtml(event.occurred_at)}</div>
      </div>
    </div>
  </div>

  ${event.origin ? `
  <div class="card">
    <h2 style="margin: 0 0 1rem; font-size: 1.125rem;">Origin</h2>
    <div class="grid">
      ${event.origin.plugin ? `
      <div>
        <div class="label">Plugin</div>
        <div class="value">${escapeHtml(event.origin.plugin)}</div>
      </div>` : ''}
      ${event.origin.runId ? `
      <div class="full">
        <div class="label">Run ID</div>
        <div class="value mono">${escapeHtml(event.origin.runId)}</div>
      </div>` : ''}
      ${event.origin.stepId ? `
      <div class="full">
        <div class="label">Step ID</div>
        <div class="value mono">${escapeHtml(event.origin.stepId)}</div>
      </div>` : ''}
    </div>
  </div>` : ''}

  ${event.action ? `
  <div class="card">
    <h2 style="margin: 0 0 1rem; font-size: 1.125rem;">Action</h2>
    <div class="grid">
      ${event.action.name ? `
      <div class="full">
        <div class="label">Name</div>
        <div class="value mono">${escapeHtml(event.action.name)}</div>
      </div>` : ''}
      ${event.action.proposed_sha256 ? `
      <div class="full">
        <div class="label">Proposed SHA-256</div>
        <div class="value mono">${escapeHtml(event.action.proposed_sha256)}</div>
      </div>` : ''}
      ${event.action.final_sha256 ? `
      <div class="full">
        <div class="label">Final SHA-256</div>
        <div class="value mono">${escapeHtml(event.action.final_sha256)}</div>
      </div>` : ''}
      ${event.action.delta ? `
      <div class="full">
        <div class="label">Delta (edited args)</div>
        <pre>${escapeHtml(JSON.stringify(event.action.delta, null, 2))}</pre>
      </div>` : ''}
      ${event.action.args ? `
      <div class="full">
        <div class="label">Arguments</div>
        <pre>${escapeHtml(JSON.stringify(event.action.args, null, 2))}</pre>
      </div>` : ''}
    </div>
  </div>` : ''}

  ${event.oversight ? `
  <div class="card">
    <h2 style="margin: 0 0 1rem; font-size: 1.125rem;">Oversight</h2>
    <div class="grid">
      ${event.oversight.reviewer_id ? `
      <div>
        <div class="label">Reviewer ID</div>
        <div class="value mono">${escapeHtml(event.oversight.reviewer_id)}</div>
      </div>` : ''}
      ${event.oversight.decision ? `
      <div>
        <div class="label">Decision</div>
        <div class="value">${escapeHtml(event.oversight.decision)}</div>
      </div>` : ''}
      ${event.oversight.decided_at ? `
      <div class="full">
        <div class="label">Decided At</div>
        <div class="value mono">${escapeHtml(event.oversight.decided_at)}</div>
      </div>` : ''}
      ${event.oversight.response ? `
      <div class="full">
        <div class="label">Response</div>
        <pre>${escapeHtml(event.oversight.response)}</pre>
      </div>` : ''}
      ${event.oversight.edit_reason ? `
      <div>
        <div class="label">Edit Reason</div>
        <div class="value">${escapeHtml(event.oversight.edit_reason)}</div>
      </div>` : ''}
      ${event.oversight.edit_reason_text ? `
      <div class="full">
        <div class="label">Edit Reason Text</div>
        <pre>${escapeHtml(event.oversight.edit_reason_text)}</pre>
      </div>` : ''}
    </div>
  </div>` : ''}

  <div class="card">
    <h2 style="margin: 0 0 1rem; font-size: 1.125rem;">Integrity</h2>
    <div class="grid">
      <div class="full">
        <div class="label">Content SHA-256</div>
        <div class="value mono">${escapeHtml(event.integrity.content_sha256)}</div>
      </div>
      ${event.integrity.prev_event_id ? `
      <div class="full">
        <div class="label">Previous Event ID</div>
        <div class="value mono">${escapeHtml(event.integrity.prev_event_id)}</div>
      </div>` : ''}
      ${event.integrity.prev_content_sha256 ? `
      <div class="full">
        <div class="label">Previous Content SHA-256</div>
        <div class="value mono">${escapeHtml(event.integrity.prev_content_sha256)}</div>
      </div>` : ''}
    </div>
  </div>

  ${event.retention ? `
  <div class="card">
    <h2 style="margin: 0 0 1rem; font-size: 1.125rem;">Retention</h2>
    <div class="grid">
      ${event.retention.min_days !== undefined ? `
      <div>
        <div class="label">Minimum Days</div>
        <div class="value">${event.retention.min_days}</div>
      </div>` : ''}
      ${event.retention.expires_at ? `
      <div>
        <div class="label">Expires At</div>
        <div class="value mono">${escapeHtml(event.retention.expires_at)}</div>
      </div>` : ''}
    </div>
  </div>` : ''}

</body>
</html>`
}

function renderApprovalChainHtml(events: EvidenceEvent[], approvalId: string, baseUrl: string): string {
  const title = `Evidence Chain: ${approvalId}`
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      line-height: 1.6; 
      max-width: 900px; 
      margin: 2rem auto; 
      padding: 0 1rem;
      background: #18181b;
      color: #fafafa;
    }
    .header { margin-bottom: 2rem; }
    .wordmark { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    .wordmark .sub { font-style: italic; font-size: 0.65em; line-height: 1; }
    .card { 
      background: #27272a; 
      border: 1px solid #3f3f46; 
      border-radius: 0.5rem; 
      padding: 1.5rem; 
      margin-bottom: 1.5rem;
      color: inherit;
    }
    .label { color: #a1a1aa; font-size: 0.875rem; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.875rem; word-break: break-all; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .event-row {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 0.375rem;
      padding: 1rem;
      margin-bottom: 0.75rem;
      color: inherit;
    }
    .event-row:hover { background: #3f3f46; }
    .event-header { display: flex; gap: 1rem; align-items: baseline; margin-bottom: 0.5rem; }
    .seq { font-weight: 600; font-size: 1.125rem; }
    .event-type { 
      background: #3730a3; 
      color: #e0e7ff;
      padding: 0.125rem 0.5rem; 
      border-radius: 0.25rem; 
      font-size: 0.75rem;
      font-weight: 500;
    }
    .event-details { font-size: 0.875rem; }
    .event-details div { margin-bottom: 0.25rem; }
  </style>
</head>
<body>
  <div class="header">
    <div class="wordmark">HITL<sub class="sub">y</sub></div>
    <p class="label">Evidence Chain</p>
    <h1 style="margin: 0.5rem 0 0; font-size: 1.25rem;" class="mono">${escapeHtml(approvalId)}</h1>
  </div>

  <div class="card">
    ${events.map(event => `
    <div class="event-row">
      <div class="event-header">
        <span class="seq">#${event.seq}</span>
        <span class="event-type">${escapeHtml(event.event_type)}</span>
      </div>
      <div class="event-details">
        <div><span class="label">Event ID:</span> <a href="${escapeHtml(baseUrl)}/events/${escapeHtml(event.event_id)}" class="mono">${escapeHtml(event.event_id)}</a></div>
        <div><span class="label">Occurred:</span> <span class="mono">${escapeHtml(event.occurred_at)}</span></div>
        ${event.integrity.prev_event_id ? `<div><span class="label">Prev Event:</span> <span class="mono">${escapeHtml(event.integrity.prev_event_id)}</span></div>` : ''}
        ${event.integrity.prev_content_sha256 ? `<div><span class="label">Prev Hash:</span> <span class="mono">${escapeHtml(event.integrity.prev_content_sha256.slice(0, 16))}...</span></div>` : ''}
        <div><span class="label">Content Hash:</span> <span class="mono">${escapeHtml(event.integrity.content_sha256.slice(0, 16))}...</span></div>
      </div>
    </div>
    `).join('')}
  </div>

  <p style="text-align: center; font-size: 0.875rem;" class="label">
    <a href="${escapeHtml(baseUrl)}">← All Approvals</a>
  </p>

</body>
</html>`
}

function renderEventsListHtml(events: EvidenceEvent[], filters: Record<string, string>, baseUrl: string): string {
  const filterDisplay = Object.entries(filters).length > 0 
    ? `Filters: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ')}`
    : 'All events'
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Evidence Store</title>
  <style>
    body { 
      font-family: system-ui, -apple-system, sans-serif; 
      line-height: 1.6; 
      max-width: 900px; 
      margin: 2rem auto; 
      padding: 0 1rem;
      background: #18181b;
      color: #fafafa;
    }
    .header { margin-bottom: 2rem; }
    .wordmark { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    .wordmark .sub { font-style: italic; font-size: 0.65em; line-height: 1; }
    .card { 
      background: #27272a; 
      border: 1px solid #3f3f46; 
      border-radius: 0.5rem; 
      padding: 1.5rem; 
      margin-bottom: 1.5rem;
      color: inherit;
    }
    .label { color: #a1a1aa; font-size: 0.875rem; }
    .mono { font-family: ui-monospace, monospace; font-size: 0.875rem; word-break: break-all; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .event-row {
      background: #27272a;
      border: 1px solid #3f3f46;
      border-radius: 0.375rem;
      padding: 1rem;
      margin-bottom: 0.75rem;
      color: inherit;
    }
    .event-row:hover { background: #3f3f46; }
    .event-details { font-size: 0.875rem; }
    .event-details div { margin-bottom: 0.25rem; }
    .filters { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .filters input { 
      padding: 0.25rem 0.5rem; 
      background: #27272a; 
      border: 1px solid #3f3f46; 
      border-radius: 0.25rem; 
      font-size: 0.75rem; 
      color: inherit;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="wordmark">HITL<sub class="sub">y</sub></div>
    <p class="label">Evidence Store</p>
  </div>

  <div class="card">
    <form method="get" class="filters">
      <input type="text" name="event_id" placeholder="event_id" value="${escapeHtml(filters.event_id || '')}">
      <input type="text" name="approval_id" placeholder="approval_id" value="${escapeHtml(filters.approval_id || '')}">
      <input type="text" name="event_type" placeholder="event_type" value="${escapeHtml(filters.event_type || '')}">
      <input type="text" name="runId" placeholder="runId" value="${escapeHtml(filters.runId || '')}">
      <input type="text" name="projectId" placeholder="projectId (optional)" value="${escapeHtml(filters.projectId || '')}">
      <button type="submit" style="padding: 0.25rem 0.75rem; border-radius: 0.25rem; border: 1px solid #3f3f46; background: #27272a; color: inherit; cursor: pointer;">Filter</button>
      <a href="${escapeHtml(baseUrl)}/" style="padding: 0.25rem 0.75rem; border-radius: 0.25rem; border: 1px solid #3f3f46; background: #27272a; font-size: 0.75rem; display: inline-block;">Clear</a>
    </form>
    <p class="label" style="margin-bottom: 1rem;">${escapeHtml(filterDisplay)} · ${events.length} event(s)</p>
    ${events.length === 0 ? '<p class="label">No events found.</p>' : events.map(event => `
    <div class="event-row">
      <div style="margin-bottom: 0.5rem;">
        <a href="${escapeHtml(baseUrl)}/events/${escapeHtml(event.event_id)}" class="mono" style="font-weight: 500;">${escapeHtml(event.event_id)}</a>
      </div>
      <div class="event-details">
        <div><span class="label">Type:</span> ${escapeHtml(event.event_type)} (seq ${event.seq})</div>
        <div><span class="label">Approval:</span> <a href="${escapeHtml(baseUrl)}/a/${escapeHtml(event.approval_id)}" class="mono">${escapeHtml(event.approval_id)}</a></div>
        <div><span class="label">Occurred:</span> <span class="mono">${escapeHtml(event.occurred_at)}</span></div>
        ${event.action?.name ? `<div><span class="label">Action:</span> ${escapeHtml(event.action.name)}</div>` : ''}
        ${event.origin?.runId ? `<div><span class="label">Run:</span> <span class="mono">${escapeHtml(event.origin.runId)}</span></div>` : ''}
      </div>
    </div>
    `).join('')}
  </div>

</body>
</html>`
}

export function createEvidenceServer(eventsDir?: string) {
  const EVENTS_DIR = eventsDir ?? process.env.EVENTS_DIR ?? './events'
  
  return createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/events') {
    let body = ''
    for await (const chunk of req) {
      body += chunk.toString()
    }

    try {
      const event = JSON.parse(body) as EvidenceEvent
      
      // Handle ping/test events
      if (event.event_type === 'ping' || req.headers['x-hitly-ping'] === 'true') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: 'Evidence sink is reachable' }))
        console.log('Received ping from HITLy')
        return
      }

      const eventId = event.event_id
      const filePath = join(EVENTS_DIR, `${eventId}.json`)
      const baseUrl = deriveBaseUrl(req)
      const storeUri = `${baseUrl}/events/${eventId}`

      await ensureEventsDir(EVENTS_DIR)

      // Idempotency: if file already exists, return existing receipt
      if (existsSync(filePath)) {
        try {
          const existing = await readFile(filePath, 'utf8')
          const existingEvent = JSON.parse(existing) as EvidenceEvent
          const receipt: AppendReceipt = {
            event_id: eventId,
            content_sha256: existingEvent.integrity.content_sha256,
            store_uri: storeUri,
            stored_at: existingEvent.occurred_at,
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(receipt))
          console.log(`Idempotent: returned existing receipt for ${eventId}`)
          return
        } catch (error) {
          console.warn(`Failed to read existing event ${eventId}, will overwrite:`, error)
        }
      }

      await writeFile(filePath, JSON.stringify(event, null, 2), 'utf8')

      const receipt: AppendReceipt = {
        event_id: eventId,
        content_sha256: event.integrity.content_sha256,
        store_uri: storeUri,
        stored_at: new Date().toISOString(),
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(receipt))
      console.log(`Stored evidence event ${eventId} (${event.event_type}) for approval ${event.approval_id}`)
    } catch (error) {
      console.error('Failed to process evidence event:', error)
      const statusCode = error instanceof Error && error.message.includes('directory') ? 500 : 400
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to process event' }))
    }
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/events/')) {
    const eventId = req.url.slice('/events/'.length)
    const filePath = join(EVENTS_DIR, `${eventId}.json`)

    if (!existsSync(filePath)) {
      res.writeHead(404, acceptsHtml(req) ? { 'Content-Type': 'text/html' } : { 'Content-Type': 'application/json' })
      res.end(acceptsHtml(req) ? '<h1>404 Not Found</h1><p>Event not found</p>' : JSON.stringify({ error: 'Event not found' }))
      return
    }

    try {
      const content = await readFile(filePath, 'utf8')
      const event = JSON.parse(content) as EvidenceEvent
      
      if (acceptsHtml(req)) {
        const baseUrl = deriveBaseUrl(req)
        const html = renderEventHtml(event, baseUrl)
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(html)
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(content)
      }
    } catch (error) {
      console.error('Failed to read evidence event:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to read event' }))
    }
    return
  }

  if (req.method === 'GET' && req.url?.startsWith('/a/')) {
    const approvalId = req.url.slice('/a/'.length)
    
    try {
      const files = await readdir(EVENTS_DIR)
      const events: EvidenceEvent[] = []
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const filePath = join(EVENTS_DIR, file)
        const content = await readFile(filePath, 'utf8')
        const event = JSON.parse(content) as EvidenceEvent
        
        if (event.approval_id === approvalId && event.event_type !== 'ping') {
          events.push(event)
        }
      }
      
      events.sort((a, b) => a.seq - b.seq)
      
      if (events.length === 0) {
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end('<h1>404 Not Found</h1><p>No events found for this approval</p>')
        return
      }
      
      const baseUrl = deriveBaseUrl(req)
      const html = renderApprovalChainHtml(events, approvalId, baseUrl)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    } catch (error) {
      console.error('Failed to list approval events:', error)
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end('<h1>500 Internal Server Error</h1>')
    }
    return
  }

  if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
    try {
      await ensureEventsDir(EVENTS_DIR)
      
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      const filters: Record<string, string> = {}
      for (const [key, value] of url.searchParams.entries()) {
        if (value) filters[key] = value
      }
      
      const files = await readdir(EVENTS_DIR)
      const events: EvidenceEvent[] = []
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const filePath = join(EVENTS_DIR, file)
        const content = await readFile(filePath, 'utf8')
        const event = JSON.parse(content) as EvidenceEvent
        
        if (event.event_type === 'ping') continue
        
        if (filters.event_id && event.event_id !== filters.event_id) continue
        if (filters.approval_id && event.approval_id !== filters.approval_id) continue
        if (filters.event_type && event.event_type !== filters.event_type) continue
        if (filters.runId && event.origin?.runId !== filters.runId) continue
        if (filters.projectId && event.origin?.projectId !== filters.projectId) continue
        
        events.push(event)
      }
      
      events.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
      
      const baseUrl = deriveBaseUrl(req)
      const html = renderEventsListHtml(events, filters, baseUrl)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    } catch (error) {
      console.error('Failed to list events:', error)
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end('<h1>500 Internal Server Error</h1>')
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
  })
}

// Only start server if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const EVENTS_DIR = process.env.EVENTS_DIR ?? './events'
  await ensureEventsDir(EVENTS_DIR)
  const server = createEvidenceServer(EVENTS_DIR)
  server.listen(PORT, () => {
    console.log(`Evidence HTTP receiver listening on http://localhost:${PORT}`)
    console.log(`Events will be written to: ${EVENTS_DIR}`)
    console.log(`Configure HITLy project evidence sink URL: http://localhost:${PORT}/events`)
  })
}
