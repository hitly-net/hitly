import {
  EVIDENCE_SPEC_VERSION,
  hashActionArgs,
  hashEvidenceContent,
  type ApprovalEnvelope,
  type DecisionPayload,
  type EvidenceEvent,
  type OriginRef,
} from '@hitly/core'
import { evidenceReceipts, projects } from '@hitly/db/schema'
import { and, eq } from 'drizzle-orm'
import { requireDb } from './tenant'
import { createEvidenceSink } from './evidence-sink'
import { decodeTenantJson } from './tenant-crypto'
import { newId } from './ids'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}


export async function buildRequestedEvent(args: {
  approvalId: string
  envelope: ApprovalEnvelope
  origin: OriginRef
  seq: number
  prevEventId?: string
  prevContentSha256?: string
}): Promise<EvidenceEvent> {
  const occurredAt = new Date().toISOString()
  const proposedSha256 = await hashActionArgs(args.envelope.action.args)

  const event: EvidenceEvent = {
    spec: EVIDENCE_SPEC_VERSION,
    event_id: newId('evt').slice(0, 36),
    approval_id: args.approvalId,
    event_type: 'requested',
    seq: args.seq,
    occurred_at: occurredAt,
    origin: {
      plugin: args.origin.plugin,
      projectId: args.origin.projectId,
      runId: args.origin.runId,
      stepId: args.origin.stepId,
    },
    agent: {
      agentId: args.origin.agentId ?? args.envelope.agentId,
      traceId: args.origin.traceId ?? args.envelope.traceId,
      spanId: args.origin.spanId ?? args.envelope.spanId,
    },
    system: {
      systemId: args.origin.systemId ?? args.envelope.systemId,
      inventoryId: args.origin.inventoryId ?? args.envelope.inventoryId,
    },
    policy: {
      policyId: args.origin.policyId ?? args.envelope.policyId,
      policyRationale: args.origin.policyRationale ?? args.envelope.policyRationale,
      riskTier: args.origin.riskTier ?? args.envelope.riskTier,
    },
    action: {
      name: args.envelope.action.name,
      args: args.envelope.action.args,
      proposed_sha256: proposedSha256,
    },
    retention: {
      min_days: 180,
      expires_at: args.envelope.expiresAt,
    },
    integrity: {
      alg: 'sha256',
      prev_event_id: args.prevEventId,
      prev_content_sha256: args.prevContentSha256,
      content_sha256: '',
    },
    toolName: args.origin.toolName ?? args.envelope.toolName,
    sensitivity: args.envelope.sensitivity,
    dataCategories: args.envelope.dataCategories,
  }

  event.integrity.content_sha256 = await hashEvidenceContent(event)
  return event
}

export async function buildDecidedEvent(args: {
  approvalId: string
  envelope: ApprovalEnvelope
  origin: OriginRef
  payload: DecisionPayload
  reviewerId: string
  seq: number
  prevEventId: string
  prevContentSha256: string
  mergedArgs?: Record<string, unknown>
}): Promise<EvidenceEvent> {
  const occurredAt = new Date().toISOString()
  const proposedSha256 = await hashActionArgs(args.envelope.action.args)

  const actionBase = {
    name: args.envelope.action.name,
    args: args.envelope.action.args,
  }

  const action =
    args.payload.decision === 'edit' && args.payload.editedArgs
      ? {
          ...actionBase,
          final_sha256: await hashActionArgs(args.mergedArgs ?? args.payload.editedArgs),
          delta: args.payload.editedArgs,
        }
      : {
          ...actionBase,
          proposed_sha256: proposedSha256,
        }

  const event: EvidenceEvent = {
    spec: EVIDENCE_SPEC_VERSION,
    event_id: newId('evt').slice(0, 36),
    approval_id: args.approvalId,
    event_type: 'decided',
    seq: args.seq,
    occurred_at: occurredAt,
    origin: {
      plugin: args.origin.plugin,
      projectId: args.origin.projectId,
      runId: args.origin.runId,
      stepId: args.origin.stepId,
    },
    agent: {
      agentId: args.origin.agentId ?? args.envelope.agentId,
      traceId: args.origin.traceId ?? args.envelope.traceId,
      spanId: args.origin.spanId ?? args.envelope.spanId,
    },
    system: {
      systemId: args.origin.systemId ?? args.envelope.systemId,
      inventoryId: args.origin.inventoryId ?? args.envelope.inventoryId,
    },
    policy: {
      policyId: args.origin.policyId ?? args.envelope.policyId,
      policyRationale: args.origin.policyRationale ?? args.envelope.policyRationale,
      riskTier: args.origin.riskTier ?? args.envelope.riskTier,
    },
    action,
    oversight: {
      reviewer_id: args.reviewerId,
      decision: args.payload.decision,
      decided_at: occurredAt,
      response: args.payload.response,
      edit_reason: args.payload.editReason,
      edit_reason_text: args.payload.editReasonText,
    },
    retention: {
      min_days: 180,
      expires_at: args.envelope.expiresAt,
    },
    integrity: {
      alg: 'sha256',
      prev_event_id: args.prevEventId,
      prev_content_sha256: args.prevContentSha256,
      content_sha256: '',
    },
    toolName: args.origin.toolName ?? args.envelope.toolName,
    sensitivity: args.envelope.sensitivity,
    dataCategories: args.envelope.dataCategories,
  }

  event.integrity.content_sha256 = await hashEvidenceContent(event)
  return event
}

export async function buildResumedEvent(args: {
  approvalId: string
  envelope: ApprovalEnvelope
  origin: OriginRef
  seq: number
  prevEventId: string
  prevContentSha256: string
  success: boolean
  mergedArgs?: Record<string, unknown>
}): Promise<EvidenceEvent> {
  const occurredAt = new Date().toISOString()
  const proposedSha256 = await hashActionArgs(args.envelope.action.args)
  const finalArgs = args.mergedArgs ?? args.envelope.action.args

  const action =
    args.mergedArgs && args.mergedArgs !== args.envelope.action.args
      ? {
          name: args.envelope.action.name,
          args: finalArgs,
          final_sha256: await hashActionArgs(finalArgs),
        }
      : {
          name: args.envelope.action.name,
          args: finalArgs,
          proposed_sha256: proposedSha256,
        }

  const event: EvidenceEvent = {
    spec: EVIDENCE_SPEC_VERSION,
    event_id: newId('evt').slice(0, 36),
    approval_id: args.approvalId,
    event_type: args.success ? 'resumed' : 'resume_failed',
    seq: args.seq,
    occurred_at: occurredAt,
    origin: {
      plugin: args.origin.plugin,
      projectId: args.origin.projectId,
      runId: args.origin.runId,
      stepId: args.origin.stepId,
    },
    agent: {
      agentId: args.origin.agentId ?? args.envelope.agentId,
      traceId: args.origin.traceId ?? args.envelope.traceId,
      spanId: args.origin.spanId ?? args.envelope.spanId,
    },
    system: {
      systemId: args.origin.systemId ?? args.envelope.systemId,
      inventoryId: args.origin.inventoryId ?? args.envelope.inventoryId,
    },
    policy: {
      policyId: args.origin.policyId ?? args.envelope.policyId,
      policyRationale: args.origin.policyRationale ?? args.envelope.policyRationale,
      riskTier: args.origin.riskTier ?? args.envelope.riskTier,
    },
    action,
    retention: {
      min_days: 180,
      expires_at: args.envelope.expiresAt,
    },
    integrity: {
      alg: 'sha256',
      prev_event_id: args.prevEventId,
      prev_content_sha256: args.prevContentSha256,
      content_sha256: '',
    },
    toolName: args.origin.toolName ?? args.envelope.toolName,
    sensitivity: args.envelope.sensitivity,
    dataCategories: args.envelope.dataCategories,
  }

  event.integrity.content_sha256 = await hashEvidenceContent(event)
  return event
}

async function loadProjectSinkConfig(projectId: string, workspaceId: string) {
  const database = requireDb()
  const rows = await database
    .select({
      evidenceSinkType: projects.evidenceSinkType,
      evidenceSinkConfig: projects.evidenceSinkConfig,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1)

  const row = rows[0]
  if (!row || row.evidenceSinkType === 'none') return null

  const config = row.evidenceSinkConfig
    ? await decodeTenantJson(workspaceId, row.evidenceSinkConfig as Record<string, unknown>)
    : {}

  const headers =
    config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)
      ? (config.headers as Record<string, string>)
      : undefined

  const metadata =
    config.metadata && typeof config.metadata === 'object' && !Array.isArray(config.metadata)
      ? (config.metadata as Record<string, unknown>)
      : undefined

  return {
    type: row.evidenceSinkType as 'none' | 'http' | 's3',
    url: optionalString(config.url),
    authHeader: optionalString(config.authHeader),
    headers,
    metadata,
    endpoint: optionalString(config.endpoint),
    region: optionalString(config.region),
    bucket: optionalString(config.bucket),
    accessKeyId: optionalString(config.accessKeyId),
    secretAccessKey: optionalString(config.secretAccessKey),
    prefix: optionalString(config.prefix),
    forcePathStyle: typeof config.forcePathStyle === 'boolean' ? config.forcePathStyle : undefined,
  }
}

export async function appendEvidence(args: {
  event: EvidenceEvent
  projectId: string
  workspaceId: string
  evidenceDurable: boolean
}) {
  const sinkConfig = await loadProjectSinkConfig(args.projectId, args.workspaceId)
  if (!sinkConfig) {
    console.log(`[evidence] No sink config for project ${args.projectId} workspace ${args.workspaceId}`)
    return null
  }
  if (sinkConfig.type === 'http' && !sinkConfig.url) {
    console.log(`[evidence] HTTP sink config has no URL`)
    return null
  }
  if (sinkConfig.type === 's3') {
    if (!sinkConfig.endpoint || !sinkConfig.bucket || !sinkConfig.accessKeyId || !sinkConfig.secretAccessKey) {
      const missing = []
      if (!sinkConfig.endpoint) missing.push('endpoint')
      if (!sinkConfig.bucket) missing.push('bucket')
      if (!sinkConfig.accessKeyId) missing.push('accessKeyId')
      if (!sinkConfig.secretAccessKey) missing.push('secretAccessKey')
      throw new Error(`Evidence sink S3 config missing required fields: ${missing.join(', ')}`)
    }
  }

  console.log(`[evidence] Sink: type=${sinkConfig.type}`)
  const sink = createEvidenceSink(sinkConfig)
  console.log(`[evidence] Appending ${args.event.event_type} event ${args.event.event_id}`)
  const receipt = await sink.append(args.event)
  console.log(`[evidence] Receipt: ${receipt.store_uri}`)

  const database = requireDb()
  await database.insert(evidenceReceipts).values({
    id: newId('evr').slice(0, 36),
    workspaceId: args.workspaceId,
    approvalId: args.event.approval_id,
    eventId: args.event.event_id,
    eventType: args.event.event_type,
    seq: args.event.seq,
    contentSha256: receipt.content_sha256,
    storeUri: receipt.store_uri,
    storedAt: new Date(receipt.stored_at),
    evidenceDurable: args.evidenceDurable,
  })

  return receipt
}

export async function loadLatestReceipt(approvalId: string, workspaceId: string) {
  const database = requireDb()
  const rows = await database
    .select()
    .from(evidenceReceipts)
    .where(and(eq(evidenceReceipts.approvalId, approvalId), eq(evidenceReceipts.workspaceId, workspaceId)))
    .orderBy(evidenceReceipts.seq)
    .limit(100)

  if (rows.length === 0) return { seq: 0, prevEventId: undefined, prevContentSha256: undefined }

  const latest = rows[rows.length - 1]
  return {
    seq: latest.seq,
    prevEventId: latest.eventId,
    prevContentSha256: latest.contentSha256,
  }
}

export async function loadEvidenceReceiptForDisplay(approvalId: string, workspaceId: string) {
  const database = requireDb()
  const rows = await database
    .select()
    .from(evidenceReceipts)
    .where(and(eq(evidenceReceipts.approvalId, approvalId), eq(evidenceReceipts.workspaceId, workspaceId)))
    .orderBy(evidenceReceipts.seq)
    .limit(100)

  if (rows.length === 0) return null

  const decidedReceipt = rows.find(r => r.eventType === 'decided')
  const receipt = decidedReceipt || rows[rows.length - 1]
  
  if (!receipt) return null

  return {
    eventId: receipt.eventId,
    eventType: receipt.eventType,
    seq: receipt.seq,
    storeUri: receipt.storeUri,
    storedAt: receipt.storedAt,
  }
}
