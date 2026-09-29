import {
  allowedActionsFor,
  type ApprovalEnvelope,
  type ConnectionCredentials,
  type DecisionPayload,
  type HitlyPlugin,
  type OriginRef,
  type ResumeResponse,
} from '@hitly/core'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// OpenShell gRPC client interfaces
export interface OpenShellResumeHandle {
  gatewayAddr: string
  workspace: string
  sandbox: string
  chunkId: string
  reviewToken: string
}

export interface OpenShellClient {
  ApproveDraftChunk(
    request: {
      workspace_scope: { workspace: string }
      sandbox: string
      chunk_id: string
      review_token: string
      request_id?: string
    },
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: { policy_version: number; policy_hash: string }) => void
  ): void
  RejectDraftChunk(
    request: {
      workspace_scope: { workspace: string }
      sandbox: string
      chunk_id: string
      reason?: string
      request_id?: string
    },
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response: Record<string, unknown>) => void
  ): void
}

export interface OpenShellConnection {
  close(): void
}

export interface OpenShellClientFactory {
  connect(gatewayAddr: string, bearerToken?: string): Promise<{ client: OpenShellClient; connection: OpenShellConnection }>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Production gRPC client factory
const productionClientFactory: OpenShellClientFactory = {
  async connect(gatewayAddr: string, bearerToken?: string) {
    const protoPath = join(__dirname, '../proto/openshell.proto')
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [join(__dirname, '../proto')],
    })

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
    const OpenShellService = protoDescriptor.openshell.v1.OpenShell

    // Use insecure for now; add TLS support when needed
    const credentials = grpc.credentials.createInsecure()
    const client = new OpenShellService(gatewayAddr, credentials) as OpenShellClient

    return {
      client,
      connection: {
        close: () => {
          // gRPC JS doesn't expose client.close() cleanly; channel closes on GC
        },
      },
    }
  },
}

let clientFactory: OpenShellClientFactory = productionClientFactory

/**
 * Override the OpenShell client factory (test-only).
 * DO NOT use this in production code.
 */
export function __setOpenShellClientFactory(factory: OpenShellClientFactory): void {
  clientFactory = factory
}

/**
 * OpenShell origin adapter: pending draft policy chunks → HITLy approval → ApproveDraftChunk/RejectDraftChunk.
 *
 * Architecture:
 * - **OpenShell** = enforce (sandbox policy / kernel isolation)
 * - **HITLy** = decide + evidence (inbox, signed resume, customer-owned sink)
 * - **NVIDIA Sentry** = silicon/out-of-band watchdog
 *
 * Flow:
 * 1. Poller (example) calls GetDraftPolicy for pending chunks
 * 2. Creates HITLy approval via POST /api/v1/approvals with plugin: 'openshell'
 * 3. Reviewer decides in HITLy inbox
 * 4. HITLy calls plugin.resume() with decision
 * 5. Plugin calls ApproveDraftChunk (accept) or RejectDraftChunk (reject)
 * 6. Evidence emitted to configured sink
 *
 * Scope: Only human_review_required / proposal_approval_mode=manual pending drafts.
 * Not: every network denial, OpenShell TUI replacement, Supervisor middleware.
 */
export const openshellPlugin: HitlyPlugin = {
  id: 'openshell',

  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef } {
    const body = asRecord(raw)

    // Required fields
    const workspace = String(body.workspace ?? '')
    const sandbox = String(body.sandbox ?? '')
    const chunkId = String(body.chunkId ?? '')
    const reviewToken = String(body.reviewToken ?? '')
    const gatewayAddr = String(body.gatewayAddr ?? '')

    if (!workspace || !sandbox || !chunkId || !reviewToken) {
      throw new Error('OpenShell ingest requires workspace, sandbox, chunkId, and reviewToken')
    }

    // Optional fields
    const actionName = optionalString(body.actionName) ?? 'approve-openshell-draft-chunk'
    const args = asRecord(body.args)
    const contextMarkdown = optionalString(body.contextMarkdown)
    const rationale = optionalString(body.rationale)
    const securityNotes = Array.isArray(body.securityNotes) ? body.securityNotes : undefined

    const allowedActionsPartial = body.allowedActions && typeof body.allowedActions === 'object'
      ? (body.allowedActions as Record<string, boolean>)
      : undefined

    return {
      action: {
        name: actionName,
        args: {
          ...args,
          chunkId,
          sandbox,
          workspace,
          rationale,
          securityNotes,
        },
      },
      allowedActions: allowedActionsFor(allowedActionsPartial ?? { accept: true, reject: true, respond: true }),
      contextMarkdown,
      origin: {
        plugin: 'openshell',
        projectId: String(body.projectId ?? ''),
        runId: `${sandbox}:${chunkId}`,
        resumeHandle: {
          gatewayAddr,
          workspace,
          sandbox,
          chunkId,
          reviewToken,
        },
        details: {
          workspace,
          sandbox,
          chunkId,
        },
      },
    }
  },

  async resume(
    origin: OriginRef,
    payload: DecisionPayload,
    credentials?: ConnectionCredentials
  ): Promise<ResumeResponse> {
    const handle = origin.resumeHandle as unknown as OpenShellResumeHandle
    const { gatewayAddr, workspace, sandbox, chunkId, reviewToken } = handle

    if (!gatewayAddr || !workspace || !sandbox || !chunkId || !reviewToken) {
      return {
        resumeData: {},
        status: 0,
        body: null,
        error: 'OpenShell resume requires gatewayAddr, workspace, sandbox, chunkId, and reviewToken',
      }
    }

    const bearerToken = typeof credentials?.token === 'string' ? credentials.token : undefined

    try {
      const { client, connection } = await clientFactory.connect(gatewayAddr, bearerToken)

      const metadata = new grpc.Metadata()
      if (bearerToken) {
        metadata.add('authorization', `Bearer ${bearerToken}`)
      }

      // Use runId as request_id for idempotency (unique per chunk)
      const requestId = `${sandbox}:${chunkId}`

      if (payload.decision === 'accept') {
        // ApproveDraftChunk
        return await new Promise((resolve) => {
          client.ApproveDraftChunk(
            {
              workspace_scope: { workspace },
              sandbox,
              chunk_id: chunkId,
              review_token: reviewToken,
              request_id: requestId,
            },
            metadata,
            (error, response) => {
              connection.close()
              if (error) {
                resolve({
                  resumeData: { decision: payload.decision, chunkId },
                  status: error.code || 500,
                  body: null,
                  error: `ApproveDraftChunk failed: ${error.message}`,
                })
              } else {
                resolve({
                  resumeData: { decision: payload.decision, chunkId, policyVersion: response.policy_version },
                  status: 200,
                  body: { policyVersion: response.policy_version, policyHash: response.policy_hash },
                })
              }
            }
          )
        })
      } else if (payload.decision === 'reject' || payload.decision === 'cancel') {
        // RejectDraftChunk
        const reason = payload.response || 'Rejected by reviewer'
        return await new Promise((resolve) => {
          client.RejectDraftChunk(
            {
              workspace_scope: { workspace },
              sandbox,
              chunk_id: chunkId,
              reason,
              request_id: requestId,
            },
            metadata,
            (error) => {
              connection.close()
              if (error) {
                resolve({
                  resumeData: { decision: payload.decision, chunkId },
                  status: error.code || 500,
                  body: null,
                  error: `RejectDraftChunk failed: ${error.message}`,
                })
              } else {
                resolve({
                  resumeData: { decision: payload.decision, chunkId, reason },
                  status: 200,
                  body: { rejected: true },
                })
              }
            }
          )
        })
      } else {
        return {
          resumeData: {},
          status: 400,
          body: null,
          error: `Unsupported decision: ${payload.decision}`,
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        resumeData: {},
        status: 500,
        body: null,
        error: `OpenShell gRPC client error: ${message}`,
      }
    }
  },

  async healthcheck(credentials: ConnectionCredentials): Promise<'ok' | 'error'> {
    const gatewayAddr = String(credentials.address ?? credentials.baseUrl ?? '')
    if (!gatewayAddr) return 'error'

    const bearerToken = typeof credentials.token === 'string' ? credentials.token : undefined

    try {
      const { connection } = await clientFactory.connect(gatewayAddr, bearerToken)
      connection.close()
      return 'ok'
    } catch {
      return 'error'
    }
  },
}

export default openshellPlugin
