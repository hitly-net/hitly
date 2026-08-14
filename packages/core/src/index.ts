export const PLUGIN_IDS = ['mastra', 'http', 'langgraph', 'temporal', 'hermes'] as const

export type PluginId = (typeof PLUGIN_IDS)[number]

export const DECISIONS = ['accept', 'reject', 'edit', 'respond', 'ignore', 'cancel'] as const

export type Decision = (typeof DECISIONS)[number]

export type ApprovalStatus = 'pending' | 'decided' | 'expired' | 'failed_resume' | 'cancelled'

export const OPEN_APPROVAL_STATUSES = ['pending', 'failed_resume'] as const
export type OpenApprovalStatus = (typeof OPEN_APPROVAL_STATUSES)[number]

export const CLOSED_APPROVAL_STATUSES = ['decided', 'expired', 'cancelled'] as const
export type ClosedApprovalStatus = (typeof CLOSED_APPROVAL_STATUSES)[number]

export function isOpenApprovalStatus(status: string): status is OpenApprovalStatus {
  return (OPEN_APPROVAL_STATUSES as readonly string[]).includes(status)
}

export function isClosedApprovalStatus(status: string): status is ClosedApprovalStatus {
  return (CLOSED_APPROVAL_STATUSES as readonly string[]).includes(status)
}

export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

export const PROJECT_ROLES = ['admin', 'user', 'reader'] as const

export type ProjectRole = (typeof PROJECT_ROLES)[number]

export const CHANNEL_TYPES = ['email', 'slack', 'telegram'] as const

export type ChannelType = (typeof CHANNEL_TYPES)[number]

export interface ActionRequest {
  name: string
  args: Record<string, unknown>
}

export type AllowedActions = Record<Decision, boolean>

export const DEFAULT_ALLOWED_ACTIONS: AllowedActions = {
  accept: true,
  reject: true,
  edit: false,
  respond: false,
  ignore: false,
  cancel: false,
}

export interface ApprovalAttachment {
  name: string
  url?: string
  contentType?: string
}

export interface ApprovalEnvelope {
  action: ActionRequest
  allowedActions: AllowedActions
  contextMarkdown?: string
  /** Opaque origin bag. HTTP echoes this unchanged on accept and reject. */
  metadata?: Record<string, unknown>
  /** Reviewer links from the origin (tickets, orders, policies). */
  externalUrls?: string[]
  /** Declared files for the reviewer. Fetch/upload is not implemented yet. */
  attachments?: ApprovalAttachment[]
  resumeSchema?: Record<string, unknown>
  expiresAt?: string
}

export interface OriginRef {
  plugin: PluginId
  projectId: string
  runId: string
  stepId?: string
  resumeHandle: Record<string, unknown>
  /** Human-facing origin labels (agent/workflow names, ids, kind). */
  details?: Record<string, string>
}

export interface DecisionPayload {
  decision: Decision
  editedArgs?: Record<string, unknown>
  response?: string
}

/** Origin HTTP/result payload stored on the inbox item after resume. */
export interface ResumeResponse {
  resumeData: Record<string, unknown>
  status: number
  body: unknown
  /** Set when the origin accepted HTTP but reported the run as failed. */
  error?: string
}

export function originResumeError(response: ResumeResponse | void): string | null {
  if (!response) return null
  if (typeof response.error === 'string' && response.error.trim()) return response.error.trim()
  if (response.status < 200 || response.status >= 300) {
    return `Origin resume failed (${response.status})`
  }
  return null
}

export interface ConnectionCredentials {
  plugin: PluginId
  [key: string]: unknown
}

export interface HitlyPlugin {
  id: PluginId
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef }
  resume(
    origin: OriginRef,
    payload: DecisionPayload,
    credentials?: ConnectionCredentials,
  ): Promise<ResumeResponse | void>
  healthcheck(credentials: ConnectionCredentials): Promise<'ok' | 'error'>
}

export interface RuleMatch {
  actionName?: string
  workflowId?: string
  plugin?: PluginId
  args?: Record<string, string>
}

export interface RuleActions {
  slaMinutes?: number
  channelTypes?: ChannelType[]
  assigneeUserId?: string
}

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === 'string' && (PLUGIN_IDS as readonly string[]).includes(value)
}

export function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value)
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value)
}

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (CHANNEL_TYPES as readonly string[]).includes(value)
}

export function allowedActionsFor(partial?: Partial<AllowedActions>): AllowedActions {
  return { ...DEFAULT_ALLOWED_ACTIONS, ...partial }
}

export function isWorkspaceAdmin(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin'
}

export {
  CLOUD_PLANS,
  COMPLETED_RETENTION_DAYS,
  FEATURES,
  FeatureUnavailableError,
  HOUSEKEEPING_SCHEDULES,
  OSS_ENTITLEMENTS,
  OSS_NAV_ITEMS,
  WORKSPACE_PLANS,
  completedRetentionDaysForPlan,
  entitlementsForPlan,
  hasFeature,
  requireFeature,
} from './edition'
export type {
  CloudPlan,
  EditionId,
  EditionNavItem,
  Entitlements,
  Feature,
  HitlyEdition,
  HousekeepingSchedule,
  WorkspacePlan,
} from './edition'
