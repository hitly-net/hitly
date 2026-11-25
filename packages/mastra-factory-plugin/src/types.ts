/**
 * Shared types for @hitly/mastra-factory-plugin.
 *
 * This module (and everything reachable from `./server`) must stay free of
 * `@mastra/*` imports so the HITLy app server can register the server-side
 * plugin without installing the Factory host packages.
 */

export type Gate = 'plan' | 'review' | 'ask_user'

export interface GateSession {
  sessionId: string
  threadId?: string
  orgId?: string
  userId?: string
  factoryProjectId?: string
}

export interface PluginRuntimeConfig {
  /** HITLy base URL (REST API origin). */
  hitlyBaseUrl: string
  /** Project-scoped HITLy API key. */
  hitlyApiKey: string
  /** HITLy project id (config endpoint scope). */
  projectId: string
  /** Public origin of the Factory host — resume callbacks target this. */
  publicBaseUrl: string
  /** Bearer token HITLy presents to our resume route (project cb_auth_token). */
  callbackBearer: string
  /** HMAC secrets (comma-separated env; rotation = overlap window). */
  resumeSecrets: string[]
  /** Env-level gate toggles. HITLy project config is authoritative when reachable. */
  gates: Record<Gate, boolean>
  /** Opt-in squash merge after explicit review accept. Default false. */
  mergeAfterAccept: boolean
  /** GitHub token for squash merges. Absent → merge-ready only. */
  githubToken?: string
  pollIntervalMs: number
}

/** HITLy approval status values relevant to this plugin. */
export type ApprovalStatusValue =
  | 'pending'
  | 'decided'
  | 'expired'
  | 'failed_resume'
  | 'cancelled'

/** Authoritative snapshot of a HITLy approval, as fetched from HITLy REST. */
export interface ApprovalSnapshot {
  id: string
  status: ApprovalStatusValue
  decision: string | null
  gate: Gate
  sessionId?: string
  threadId?: string
  toolCallId?: string
  orgId?: string
  userId?: string
  factoryProjectId?: string
  reason?: string
  editedArgs?: Record<string, unknown>
  response?: string
  headSha?: string
  prUrl?: string
  metadata: Record<string, unknown>
}

export interface ApplyOutcome {
  applied: boolean
  reason?: string
}

/** Body posted to HITLy POST /api/v1/approvals (HTTP-plugin ingest contract superset). */
export interface ApprovalRequest {
  plugin: string
  runId: string
  actionName?: string
  contextMarkdown?: string
  prompt?: string
  question?: string
  resumeUrl?: string
  idempotencyKey?: string
  metadata?: Record<string, string>
  allowedActions?: Partial<Record<'accept' | 'reject' | 'edit' | 'respond' | 'ignore' | 'cancel', boolean>>
  reasonRequired?: boolean
  expiresAt?: string
  args?: unknown
}

export interface ApprovalRef {
  id: string
  status: ApprovalStatusValue
}
