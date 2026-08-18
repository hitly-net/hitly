import { createServer } from 'node:http'
import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.PORT ? Number(process.env.PORT) : 3100
const EVENTS_DIR = process.env.EVENTS_DIR ?? './events'

async function ensureEventsDir() {
  if (!existsSync(EVENTS_DIR)) {
    await mkdir(EVENTS_DIR, { recursive: true })
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

const server = createServer(async (req, res) => {
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

      await ensureEventsDir()
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
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON body' }))
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

await ensureEventsDir()
server.listen(PORT, () => {
  console.log(`Evidence HTTP receiver listening on http://localhost:${PORT}`)
  console.log(`Events will be written to: ${EVENTS_DIR}`)
  console.log(`Configure Hitly project evidence sink URL: http://localhost:${PORT}/events`)
})
