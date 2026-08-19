import type { AppendReceipt, EvidenceEvent, EvidenceSink } from '@hitly/core'

export interface HttpSinkConfig {
  url: string
  authHeader?: string
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface S3SinkConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
  forcePathStyle?: boolean
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

export class S3EvidenceSink implements EvidenceSink {
  id = 's3' as const
  private config: S3SinkConfig

  constructor(config: S3SinkConfig) {
    const isAwsEndpoint = config.endpoint.includes('amazonaws.com')
    const forcePathStyle = config.forcePathStyle !== undefined ? config.forcePathStyle : !isAwsEndpoint
    this.config = { ...config, forcePathStyle }
  }

  private async sha256(data: string): Promise<string> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder()
      const dataBuffer = encoder.encode(data)
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
    }
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(data, 'utf8').digest('hex')
  }

  private async hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const encoder = new TextEncoder()
      const keyBuffer = (typeof key === 'string' ? encoder.encode(key) : key) as BufferSource
      const dataBuffer = encoder.encode(data)
      const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer)
      return new Uint8Array(signature)
    }
    const { createHmac } = await import('node:crypto')
    const hmac = createHmac('sha256', key)
    hmac.update(data, 'utf8')
    return new Uint8Array(hmac.digest())
  }

  private async getSignatureKey(dateStamp: string): Promise<Uint8Array> {
    const kDate = await this.hmacSha256(`AWS4${this.config.secretAccessKey}`, dateStamp)
    const kRegion = await this.hmacSha256(kDate, this.config.region)
    const kService = await this.hmacSha256(kRegion, 's3')
    return this.hmacSha256(kService, 'aws4_request')
  }

  private getObjectKey(eventId: string): string {
    const prefix = this.config.prefix ? this.config.prefix.replace(/\/+$/, '') : ''
    const filename = `${eventId}.json`
    return prefix ? `${prefix}/${filename}` : filename
  }

  private getObjectUrl(key: string): string {
    const endpoint = this.config.endpoint.replace(/\/+$/, '')
    if (this.config.forcePathStyle) {
      return `${endpoint}/${this.config.bucket}/${key}`
    }
    const url = new URL(endpoint)
    url.hostname = `${this.config.bucket}.${url.hostname}`
    return `${url.origin}/${key}`
  }

  async append(event: EvidenceEvent): Promise<AppendReceipt> {
    const body = JSON.stringify(event)
    const key = this.getObjectKey(event.event_id)
    const objectUrl = this.getObjectUrl(key)

    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)

    const endpoint = this.config.endpoint.replace(/\/+$/, '')
    const url = new URL(endpoint)
    const baseHost = this.config.forcePathStyle ? url.hostname : `${this.config.bucket}.${url.hostname}`
    const isNonStandardPort = url.port && ((url.protocol === 'https:' && url.port !== '443') || (url.protocol === 'http:' && url.port !== '80'))
    const host = isNonStandardPort ? `${baseHost}:${url.port}` : baseHost
    const canonicalUri = this.config.forcePathStyle ? `/${this.config.bucket}/${key}` : `/${key}`

    const payloadHash = await this.sha256(body)

    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'

    const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`

    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await this.sha256(canonicalRequest)}`

    const signingKey = await this.getSignatureKey(dateStamp)
    const signatureBytes = await this.hmacSha256(signingKey, stringToSign)
    const signature = Array.from(signatureBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

    const putUrl = `${url.protocol}//${host}${canonicalUri}`

    const response = await fetch(putUrl, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'host': host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'authorization': authorizationHeader,
      },
      body,
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const snippet = text.slice(0, 200)
      throw new Error(`Evidence sink S3 PutObject failed (${response.status}): ${snippet}`)
    }

    const storedAt = new Date().toISOString()
    return {
      event_id: event.event_id,
      content_sha256: event.integrity.content_sha256,
      store_uri: objectUrl,
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
  type: 'none' | 'http' | 's3'
  url?: string
  authHeader?: string
  headers?: Record<string, string>
  metadata?: Record<string, unknown>
  endpoint?: string
  region?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
  prefix?: string
  forcePathStyle?: boolean
}): EvidenceSink {
  if (config.type === 'http' && config.url) {
    return new HttpEvidenceSink({
      url: config.url,
      authHeader: config.authHeader,
      headers: config.headers,
      metadata: config.metadata,
    })
  }
  if (config.type === 's3') {
    if (!config.endpoint || !config.region || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      const missing = []
      if (!config.endpoint) missing.push('endpoint')
      if (!config.region) missing.push('region')
      if (!config.bucket) missing.push('bucket')
      if (!config.accessKeyId) missing.push('accessKeyId')
      if (!config.secretAccessKey) missing.push('secretAccessKey')
      throw new Error(`Evidence sink S3 config missing required fields: ${missing.join(', ')}`)
    }
    const isAwsEndpoint = config.endpoint.includes('amazonaws.com')
    const forcePathStyle = config.forcePathStyle !== undefined ? config.forcePathStyle : !isAwsEndpoint
    return new S3EvidenceSink({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      prefix: config.prefix,
      forcePathStyle,
    })
  }
  return new NoneSink()
}
