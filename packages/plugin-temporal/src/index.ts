import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'
import { Connection, WorkflowClient } from '@temporalio/client'

export const HITLY_TEMPORAL_SIGNAL = 'hitly.decision'

// Temporal client factory for dependency injection (test-only override)
export interface TemporalConnection {
  close(): Promise<void>
}

export interface TemporalWorkflowHandle {
  signal(signalName: string, payload: unknown): Promise<void>
}

export interface TemporalWorkflowClient {
  getHandle(workflowId: string): TemporalWorkflowHandle
}

export interface TemporalClientFactory {
  connect(options: { address: string; tls?: boolean; apiKey?: string }): Promise<TemporalConnection>
  createClient(options: { connection: TemporalConnection; namespace: string }): TemporalWorkflowClient
}

let clientFactory: TemporalClientFactory = {
  async connect(options) {
    return (await Connection.connect(options)) as unknown as TemporalConnection
  },
  createClient(options) {
    return new WorkflowClient(options as any) as unknown as TemporalWorkflowClient
  },
}

/**
 * Override the Temporal client factory (test-only).
 * DO NOT use this in production code.
 */
export function __setTemporalClientFactory(factory: TemporalClientFactory): void {
  clientFactory = factory
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((item) => optionalString(item)).filter((item): item is string => Boolean(item))
  return out.length > 0 ? out : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export interface TemporalResumeHandle {
  address: string
  namespace: string
  workflowId: string
  signal: string
}

/**
 * Temporal pause: activity creates the approval, then condition() until a signal.
 * Resume: Signal `hitly.decision` with { decision, args }.
 * HITLy does NOT hold a worker. Resume is signal only.
 */
export const temporalPlugin: HitlyPlugin = {
  id: 'temporal',
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = asRecord(raw)
    const workflowId = String(body.workflowId ?? '')
    const address = String(body.address ?? '')
    const namespace = String(body.namespace ?? 'default')

    // Require workflowId (throw if missing/blank)
    if (!workflowId) {
      throw new Error('Temporal ingest requires workflowId')
    }

    const traceId = optionalString(body.traceId)
    const spanId = optionalString(body.spanId)
    const systemId = optionalString(body.systemId)
    const inventoryId = optionalString(body.inventoryId)
    const policyId = optionalString(body.policyId)
    const policyRationale = optionalString(body.policyRationale)
    const riskTier = optionalString(body.riskTier)
    const toolName = optionalString(body.toolName)
    const sensitivity = stringList(body.sensitivity)
    const dataCategories = stringList(body.dataCategories)

    return {
      action: {
        name: String(body.actionName ?? 'temporal-approval'),
        args: asRecord(body.args),
      },
      allowedActions: allowedActionsFor({ accept: true, reject: true }),
      contextMarkdown: optionalString(body.contextMarkdown),
      traceId,
      spanId,
      systemId,
      inventoryId,
      policyId,
      policyRationale,
      riskTier,
      toolName,
      sensitivity,
      dataCategories,
      origin: {
        plugin: 'temporal',
        projectId: String(body.projectId ?? ''),
        runId: workflowId,
        resumeHandle: {
          address,
          namespace,
          workflowId,
          signal: HITLY_TEMPORAL_SIGNAL,
        },
        details: Object.fromEntries(
          Object.entries({
            workflowId: workflowId || undefined,
            workflowName: optionalString(body.workflowName),
            namespace,
          }).filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
        traceId,
        spanId,
        systemId,
        inventoryId,
        policyId,
        policyRationale,
        riskTier,
        toolName,
      },
    }
  },
  async resume(
    origin: OriginRef,
    payload: DecisionPayload,
    credentials?: ConnectionCredentials,
  ): Promise<ResumeResponse> {
    const handle = origin.resumeHandle as unknown as TemporalResumeHandle
    const address = handle.address
    const namespace = handle.namespace ?? 'default'
    const workflowId = handle.workflowId

    if (!address || !workflowId) {
      return {
        resumeData: {},
        status: 0,
        body: null,
        error: 'Temporal resume requires address and workflowId',
      }
    }

    try {
      const connectionOptions: { address: string; tls?: boolean; apiKey?: string } = { address }

      // Add TLS/credentials if available (for Temporal Cloud)
      if (typeof credentials?.token === 'string' && credentials.token) {
        connectionOptions.tls = true
        connectionOptions.apiKey = credentials.token
      } else if (typeof credentials?.apiKey === 'string' && credentials.apiKey) {
        connectionOptions.tls = true
        connectionOptions.apiKey = credentials.apiKey
      }

      const connection = await clientFactory.connect(connectionOptions)
      const client = clientFactory.createClient({ connection, namespace })
      const workflow = client.getHandle(workflowId)

      // Build signal payload: { decision, args }
      const signalPayload: Record<string, unknown> = {
        decision: payload.decision,
      }

      // Include editedArgs when present (for 'edit' decision)
      if (payload.editedArgs) {
        signalPayload.args = payload.editedArgs
      }

      // Signal the workflow
      await workflow.signal(HITLY_TEMPORAL_SIGNAL, signalPayload)

      return {
        resumeData: signalPayload,
        status: 200,
        body: { signaled: true, workflowId, signal: HITLY_TEMPORAL_SIGNAL },
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        resumeData: {},
        status: 500,
        body: null,
        error: `Temporal signal failed: ${message}`,
      }
    }
  },
  async healthcheck(credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    const address = String(credentials.address ?? credentials.baseUrl ?? '')
    if (!address) return 'error'

    try {
      const connectionOptions: { address: string; tls?: boolean; apiKey?: string } = { address }

      // Add TLS/credentials if available (for Temporal Cloud)
      if (typeof credentials.token === 'string' && credentials.token) {
        connectionOptions.tls = true
        connectionOptions.apiKey = credentials.token
      } else if (typeof credentials.apiKey === 'string' && credentials.apiKey) {
        connectionOptions.tls = true
        connectionOptions.apiKey = credentials.apiKey
      }

      const connection = await clientFactory.connect(connectionOptions)
      await connection.close()
      return 'ok'
    } catch {
      return 'error'
    }
  },
}

export default temporalPlugin
