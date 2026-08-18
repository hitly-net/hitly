import { createServer } from 'node:http'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'

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
  }
}

interface AppendReceipt {
  event_id: string
  content_sha256: string
  store_uri: string
  stored_at: string
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
        console.log('Received ping from Hitly')
        return
      }

      const eventId = event.event_id
      const filePath = join(EVENTS_DIR, `${eventId}.json`)

      await ensureEventsDir(EVENTS_DIR)

      // Idempotency: if file already exists, return existing receipt
      if (existsSync(filePath)) {
        try {
          const existing = await readFile(filePath, 'utf8')
          const existingEvent = JSON.parse(existing) as EvidenceEvent
          const receipt: AppendReceipt = {
            event_id: eventId,
            content_sha256: existingEvent.integrity.content_sha256,
            store_uri: `file://${filePath}`,
            stored_at: existingEvent.occurred_at, // Use original stored time
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(receipt))
          console.log(`Idempotent: returned existing receipt for ${eventId}`)
          return
        } catch (error) {
          // If we can't read existing file, fall through to write new one
          console.warn(`Failed to read existing event ${eventId}, will overwrite:`, error)
        }
      }

      await writeFile(filePath, JSON.stringify(event, null, 2), 'utf8')

      const receipt: AppendReceipt = {
        event_id: eventId,
        content_sha256: event.integrity.content_sha256,
        store_uri: `file://${filePath}`,
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
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Event not found' }))
      return
    }

    try {
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(filePath, 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(content)
    } catch (error) {
      console.error('Failed to read evidence event:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to read event' }))
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
    console.log(`Configure Hitly project evidence sink URL: http://localhost:${PORT}/events`)
  })
}
