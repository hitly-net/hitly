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
import { readFileSync } from 'node:fs'

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

export interface TlsConfig {
  /** Path to CA certificate file, or PEM-encoded CA cert string */
  ca?: string
  /** Path to client certificate file, or PEM-encoded client cert string */
  cert?: string
  /** Path to client private key file, or PEM-encoded client key string */
  key?: string
  /** 
   * Optional channel override for hostname verification
   * Use when connecting to 127.0.0.1 with a cert that has a different CN
   * Example: 'grpc.ssl_target_name_override' -> 'openshell.local'
   */
  checkServerIdentity?: boolean
  sslTargetNameOverride?: string
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
  connect(
    gatewayAddr: string,
    bearerToken?: string,
    tlsConfig?: TlsConfig,
    insecure?: boolean
  ): Promise<{ client: OpenShellClient; connection: OpenShellConnection }>
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * Load TLS material from file path or return as PEM string if already in PEM format.
 * Detects PEM format by checking for BEGIN/END markers.
 */
function loadTlsMaterial(pathOrPem: string): Buffer {
  const trimmed = pathOrPem.trim()
  // If it looks like PEM (contains BEGIN/END markers), return as-is
  if (trimmed.includes('-----BEGIN') && trimmed.includes('-----END')) {
    return Buffer.from(trimmed, 'utf-8')
  }
  // Otherwise treat as file path
  return readFileSync(pathOrPem)
}

/**
 * Create gRPC channel credentials based on TLS configuration.
 * - If insecure=true: createInsecure (dev/test only, explicit opt-in)
 * - If tlsConfig provided: createSsl with CA + client cert/key for mTLS
 * - Otherwise: throw error (fail-closed, require explicit TLS or insecure flag)
 */
function createGrpcCredentials(tlsConfig?: TlsConfig, insecure?: boolean): grpc.ChannelCredentials {
  // Explicit insecure mode (dev/test only)
  if (insecure === true) {
    return grpc.credentials.createInsecure()
  }

  // TLS/mTLS mode
  if (tlsConfig && (tlsConfig.ca || tlsConfig.cert || tlsConfig.key)) {
    const rootCerts = tlsConfig.ca ? loadTlsMaterial(tlsConfig.ca) : undefined
    const privateKey = tlsConfig.key ? loadTlsMaterial(tlsConfig.key) : undefined
    const certChain = tlsConfig.cert ? loadTlsMaterial(tlsConfig.cert) : undefined

    // Validate mTLS: if client cert is provided, key must also be provided
    if ((certChain && !privateKey) || (!certChain && privateKey)) {
      throw new Error('TLS client cert and key must both be provided for mTLS')
    }

    const sslCreds = grpc.credentials.createSsl(rootCerts, privateKey, certChain)

    // Apply channel options if SSL target name override is specified
    // (This is handled via channel args in the client constructor below)
    return sslCreds
  }

  // Fail-closed: require explicit TLS config or insecure flag
  throw new Error(
    'OpenShell gRPC client requires TLS configuration (tlsCaFile, tlsCertFile, tlsKeyFile) or explicit insecure flag (tlsInsecure=true) for dev/test only'
  )
}

// Production gRPC client factory
const productionClientFactory: OpenShellClientFactory = {
  async connect(gatewayAddr: string, bearerToken?: string, tlsConfig?: TlsConfig, insecure?: boolean) {
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

    // Create channel credentials (TLS/mTLS or insecure)
    const credentials = createGrpcCredentials(tlsConfig, insecure)

    // Build channel args for SSL target name override if needed
    const channelArgs: Record<string, any> = {}
    if (tlsConfig?.sslTargetNameOverride) {
      channelArgs['grpc.ssl_target_name_override'] = tlsConfig.sslTargetNameOverride
    }
    if (tlsConfig?.checkServerIdentity === false) {
      // Disable hostname verification (use with caution)
      channelArgs['grpc.ssl_target_name_override'] = tlsConfig.sslTargetNameOverride || 'localhost'
    }

    const client = new OpenShellService(gatewayAddr, credentials, channelArgs) as OpenShellClient

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

    // Extract TLS configuration from credentials
    const tlsCa = optionalString(credentials?.tlsCaFile || credentials?.tlsCa)
    const tlsCert = optionalString(credentials?.tlsCertFile || credentials?.tlsCert)
    const tlsKey = optionalString(credentials?.tlsKeyFile || credentials?.tlsKey)
    const tlsSslTargetNameOverride = optionalString(credentials?.tlsSslTargetNameOverride)
    const tlsCheckServerIdentity = credentials?.tlsCheckServerIdentity

    const tlsConfig: TlsConfig | undefined = 
      tlsCa || tlsCert || tlsKey || tlsSslTargetNameOverride || tlsCheckServerIdentity !== undefined
        ? {
            ca: tlsCa,
            cert: tlsCert,
            key: tlsKey,
            sslTargetNameOverride: tlsSslTargetNameOverride,
            checkServerIdentity: tlsCheckServerIdentity === false ? false : undefined,
          }
        : undefined

    const insecure = (credentials?.tlsInsecure === true || credentials?.insecure === true) ? true : undefined

    try {
      const { client, connection } = await clientFactory.connect(gatewayAddr, bearerToken, tlsConfig, insecure)

      const metadata = new grpc.Metadata()
      if (bearerToken) {
        metadata.add('authorization', `Bearer ${bearerToken}`)
      }

      // Use chunkId as request_id for idempotency (hyphenated UUID)
      const requestId = chunkId

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

    // Extract TLS configuration
    const tlsCa = optionalString(credentials.tlsCaFile || credentials.tlsCa)
    const tlsCert = optionalString(credentials.tlsCertFile || credentials.tlsCert)
    const tlsKey = optionalString(credentials.tlsKeyFile || credentials.tlsKey)
    const tlsSslTargetNameOverride = optionalString(credentials.tlsSslTargetNameOverride)
    const tlsCheckServerIdentity = credentials.tlsCheckServerIdentity

    const tlsConfig: TlsConfig | undefined = 
      tlsCa || tlsCert || tlsKey || tlsSslTargetNameOverride || tlsCheckServerIdentity !== undefined
        ? {
            ca: tlsCa,
            cert: tlsCert,
            key: tlsKey,
            sslTargetNameOverride: tlsSslTargetNameOverride,
            checkServerIdentity: tlsCheckServerIdentity === false ? false : undefined,
          }
        : undefined

    const insecure = (credentials.tlsInsecure === true || credentials.insecure === true) ? true : undefined

    try {
      const { connection } = await clientFactory.connect(gatewayAddr, bearerToken, tlsConfig, insecure)
      connection.close()
      return 'ok'
    } catch {
      return 'error'
    }
  },
}

export default openshellPlugin
