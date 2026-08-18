import type { AppendReceipt, EvidenceEvent, EvidenceSink } from '@hitly/core'

export interface HttpSinkConfig {
  url: string
  authHeader?: string
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
}

export class HttpEvidenceSink implements EvidenceSink {
  id = 'http' as const
  private config: HttpSinkConfig

  constructor(config: HttpSinkConfig) {
    this.config = config
  }

  async append(event: EvidenceEvent): Promise<AppendReceipt> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': event.event_id,
    }

    if (this.config.headers) {
      for (const [name, value] of Object.entries(this.config.headers)) {
        if (name && name !== 'content-type' && name !== 'idempotency-key') {
          headers[name] = value
        }
      }
    }

    if (this.config.authHeader) {
      headers.authorization = this.config.authHeader
    }

    if (this.config.metadata && Object.keys(this.config.metadata).length > 0) {
      headers['X-Hitly-Metadata'] = JSON.stringify(this.config.metadata)
    }

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const snippet = text.slice(0, 200)
      throw new Error(`Evidence sink HTTP POST failed (${response.status}): ${snippet}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const json = await response.json()
      if (json && typeof json === 'object') {
        if (
          typeof json.event_id === 'string' &&
          typeof json.content_sha256 === 'string' &&
          typeof json.store_uri === 'string' &&
          typeof json.stored_at === 'string'
        ) {
          return {
            event_id: json.event_id,
            content_sha256: json.content_sha256,
            store_uri: json.store_uri,
            stored_at: json.stored_at,
          }
        }
      }
    }

    const storeUri = `${this.config.url}/${event.event_id}`
    const storedAt = new Date().toISOString()
    return {
      event_id: event.event_id,
      content_sha256: event.integrity.content_sha256,
      store_uri: storeUri,
      stored_at: storedAt,
    }
  }
}

export class NoneSink implements EvidenceSink {
  id = 'none' as const

  async append(event: EvidenceEvent): Promise<AppendReceipt> {
    return {
      event_id: event.event_id,
      content_sha256: event.integrity.content_sha256,
      store_uri: '',
      stored_at: new Date().toISOString(),
    }
  }
}

export function createEvidenceSink(config: {
  type: 'none' | 'http'
  url?: string
  authHeader?: string
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
}): EvidenceSink {
  if (config.type === 'http' && config.url) {
    return new HttpEvidenceSink({
      url: config.url,
      authHeader: config.authHeader,
      headers: config.headers,
      metadata: config.metadata,
    })
  }
  return new NoneSink()
}
