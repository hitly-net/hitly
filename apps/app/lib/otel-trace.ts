import type { ApprovalEnvelope, DecisionPayload, EvidenceEvent, OriginRef } from '@hitly/core'
import { workspaceOtelEndpoints } from '@hitly/db/schema'
import { and, eq } from 'drizzle-orm'
import { requireDb } from './tenant'
import { decodeTenantJson } from './tenant-crypto'
import { ProtobufTraceSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'

export interface OtelSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>
  status: { code: number }
}

export interface OtelResourceSpan {
  resource: {
    attributes: Array<{ key: string; value: { stringValue?: string } }>
  }
  scopeSpans: Array<{
    scope: { name: string; version: string }
    spans: OtelSpan[]
  }>
}

export interface OtelTraceRequest {
  resourceSpans: OtelResourceSpan[]
}

function w3cTraceId(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined
  const stripped = input.replace(/[^0-9a-fA-F]/g, '')
  if (stripped.length === 32) return stripped.toLowerCase()
  if (stripped.length > 32) return stripped.slice(0, 32).toLowerCase()
  return undefined
}

function w3cSpanId(input?: string): string | undefined {
  if (!input || typeof input !== 'string') return undefined
  const stripped = input.replace(/[^0-9a-fA-F]/g, '')
  if (stripped.length === 16) return stripped.toLowerCase()
  if (stripped.length > 16) return stripped.slice(0, 16).toLowerCase()
  return undefined
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function generateSpanId(): string {
  const bytes = new Uint8Array(8)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 8; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function stringAttr(key: string, value: string | undefined) {
  if (!value) return null
  return { key, value: { stringValue: value } }
}

function intAttr(key: string, value: number | undefined) {
  if (value === undefined) return null
  return { key, value: { intValue: String(value) } }
}

export function buildOtelSpan(args: {
  event: EvidenceEvent
  envelope: ApprovalEnvelope
  origin: OriginRef
  payload?: DecisionPayload
  workspaceId: string
}): OtelTraceRequest {
  const traceId = w3cTraceId(args.origin.traceId || args.envelope.traceId) || generateTraceId()
  const parentSpanId = w3cSpanId(args.origin.spanId || args.envelope.spanId)
  const spanId = generateSpanId()
  const now = Date.now()
  const startTimeUnixNano = String(now * 1_000_000)
  const endTimeUnixNano = startTimeUnixNano

  const attributes = [
    stringAttr('hitly.approval_id', args.event.approval_id),
    stringAttr('hitly.plugin', args.origin.plugin),
    stringAttr('hitly.action_name', args.envelope.action.name),
    stringAttr('hitly.status', args.event.event_type),
    stringAttr('hitly.event_type', args.event.event_type),
    stringAttr('hitly.event_id', args.event.event_id),
    intAttr('hitly.seq', args.event.seq),
    stringAttr('hitly.agent_id', args.origin.agentId || args.envelope.agentId),
    stringAttr('hitly.system_id', args.origin.systemId || args.envelope.systemId),
    stringAttr('hitly.risk_tier', args.origin.riskTier || args.envelope.riskTier),
    stringAttr('hitly.policy_id', args.origin.policyId || args.envelope.policyId),
  ].filter((attr): attr is NonNullable<typeof attr> => attr !== null)

  if (args.event.event_type === 'decided' && args.payload) {
    const decisionAttr = stringAttr('hitly.decision', args.payload.decision)
    if (decisionAttr) attributes.push(decisionAttr)
  }

  const contentHashAttr = stringAttr('hitly.content_sha256', args.event.integrity?.content_sha256)
  if (contentHashAttr) attributes.push(contentHashAttr)

  const span: OtelSpan = {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: `hitly.approval.${args.event.event_type}`,
    kind: 1,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    status: { code: 1 },
  }

  const resourceSpan: OtelResourceSpan = {
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: 'hitly' } },
        { key: 'hitly.workspace_id', value: { stringValue: args.workspaceId } },
        { key: 'hitly.project_id', value: { stringValue: args.origin.projectId } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: 'hitly', version: '1.0.0' },
        spans: [span],
      },
    ],
  }

  return {
    resourceSpans: [resourceSpan],
  }
}

interface OtelEndpointConfig {
  name: string
  endpoint: string
  protocol: 'http/protobuf' | 'http/json'
  headers?: Record<string, string>
  enabled: boolean
}

async function loadWorkspaceOtelEndpoints(workspaceId: string): Promise<OtelEndpointConfig[]> {
  const database = requireDb()
  const rows = await database
    .select()
    .from(workspaceOtelEndpoints)
    .where(and(eq(workspaceOtelEndpoints.workspaceId, workspaceId), eq(workspaceOtelEndpoints.enabled, true)))

  const configs: OtelEndpointConfig[] = []
  for (const row of rows) {
    const headers = row.headers ? await decodeTenantJson(workspaceId, row.headers as Record<string, unknown>) : {}
    const headersMap: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        headersMap[key] = value
      }
    }

    configs.push({
      name: row.name,
      endpoint: row.endpoint,
      protocol: row.protocol,
      headers: headersMap,
      enabled: row.enabled,
    })
  }

  return configs
}

async function postOtelTrace(config: OtelEndpointConfig, trace: OtelTraceRequest): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    let body: Uint8Array
    let contentType: string

    if (config.protocol === 'http/protobuf') {
      // Convert OTLP structure to ReadableSpan-like format for serializer
      const readableSpans = trace.resourceSpans.flatMap(rs =>
        rs.scopeSpans.flatMap(ss =>
          ss.spans.map(span => ({
            name: span.name,
            kind: span.kind,
            spanContext: () => ({
              traceId: span.traceId,
              spanId: span.spanId,
              traceFlags: 1,
            }),
            parentSpanId: span.parentSpanId,
            startTime: span.startTimeUnixNano ? [0, Number(span.startTimeUnixNano)] : [0, 0],
            endTime: span.endTimeUnixNano ? [0, Number(span.endTimeUnixNano)] : [0, 0],
            status: { code: 0 },
            attributes: Object.fromEntries(
              span.attributes.map(attr => [
                attr.key,
                attr.value.stringValue ?? null
              ])
            ),
            links: [],
            events: [],
            duration: [0, 0],
            ended: true,
            resource: {
              attributes: Object.fromEntries(
                rs.resource.attributes.map(attr => [
                  attr.key,
                  attr.value.stringValue ?? null
                ])
              ),
            },
            instrumentationScope: {
              name: ss.scope.name,
              version: ss.scope.version,
            },
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
          }))
        )
      )

      // Serialize to protobuf binary
      body = ProtobufTraceSerializer.serializeRequest(readableSpans as unknown as ReadableSpan[]) ?? new Uint8Array(0)
      contentType = 'application/x-protobuf'
    } else {
      // http/json: serialize with JsonTraceSerializer
      const readableSpans = trace.resourceSpans.flatMap(rs =>
        rs.scopeSpans.flatMap(ss =>
          ss.spans.map(span => ({
            name: span.name,
            kind: span.kind,
            spanContext: () => ({
              traceId: span.traceId,
              spanId: span.spanId,
              traceFlags: 1,
            }),
            parentSpanId: span.parentSpanId,
            startTime: span.startTimeUnixNano ? [0, Number(span.startTimeUnixNano)] : [0, 0],
            endTime: span.endTimeUnixNano ? [0, Number(span.endTimeUnixNano)] : [0, 0],
            status: { code: 0 },
            attributes: Object.fromEntries(
              span.attributes.map(attr => [
                attr.key,
                attr.value.stringValue ?? null
              ])
            ),
            links: [],
            events: [],
            duration: [0, 0],
            ended: true,
            resource: {
              attributes: Object.fromEntries(
                rs.resource.attributes.map(attr => [
                  attr.key,
                  attr.value.stringValue ?? null
                ])
              ),
            },
            instrumentationScope: {
              name: ss.scope.name,
              version: ss.scope.version,
            },
            droppedAttributesCount: 0,
            droppedEventsCount: 0,
            droppedLinksCount: 0,
          }))
        )
      )

      body = JsonTraceSerializer.serializeRequest(readableSpans as unknown as ReadableSpan[]) ?? new Uint8Array(0)
      contentType = 'application/json'
    }

    const headers: Record<string, string> = {
      ...config.headers,
      'Content-Type': contentType,
    }

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: body as BodyInit,
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error(`[otel] Export to ${config.name} failed: ${response.status} ${response.statusText}`)
    } else {
      console.log(`[otel] Exported ${trace.resourceSpans[0].scopeSpans[0].spans[0].name} to ${config.name}`)
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        console.error(`[otel] Export to ${config.name} timed out`)
      } else {
        console.error(`[otel] Export to ${config.name} failed:`, error.message)
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function exportOtelTrace(args: {
  event: EvidenceEvent
  envelope: ApprovalEnvelope
  origin: OriginRef
  payload?: DecisionPayload
  workspaceId: string
}): Promise<void> {
  const endpoints = await loadWorkspaceOtelEndpoints(args.workspaceId)

  if (endpoints.length === 0) {
    return
  }

  const trace = buildOtelSpan({
    event: args.event,
    envelope: args.envelope,
    origin: args.origin,
    payload: args.payload,
    workspaceId: args.workspaceId,
  })

  await Promise.allSettled(endpoints.map(config => postOtelTrace(config, trace)))
}
