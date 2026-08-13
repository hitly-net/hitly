export const PLUGIN_IDS = ['mastra', 'n8n', 'langgraph', 'temporal'] as const

export type PluginId = (typeof PLUGIN_IDS)[number]

export const DECISIONS = ['accept', 'reject', 'edit', 'respond', 'ignore'] as const

export type Decision = (typeof DECISIONS)[number]

export type ApprovalStatus = 'pending' | 'decided' | 'expired' | 'failed_resume'

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
}

export interface ApprovalEnvelope {
  action: ActionRequest
  allowedActions: AllowedActions
  contextMarkdown?: string
  resumeSchema?: Record<string, unknown>
  expiresAt?: string
}

export interface OriginRef {
  plugin: PluginId
  connectionId: string
  runId: string
  stepId?: string
  resumeHandle: Record<string, unknown>
}

export interface DecisionPayload {
  decision: Decision
  editedArgs?: Record<string, unknown>
  response?: string
}

export interface ConnectionCredentials {
  plugin: PluginId
  [key: string]: unknown
}

export interface HitlyPlugin {
  id: PluginId
  ingest(raw: unknown): ApprovalEnvelope & { origin: OriginRef }
  resume(origin: OriginRef, payload: DecisionPayload): Promise<void>
  healthcheck(credentials: ConnectionCredentials): Promise<'ok' | 'error'>
}

export function isPluginId(value: unknown): value is PluginId {
  return typeof value === 'string' && (PLUGIN_IDS as readonly string[]).includes(value)
}

export function isDecision(value: unknown): value is Decision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
}

export function allowedActionsFor(partial?: Partial<AllowedActions>): AllowedActions {
  return { ...DEFAULT_ALLOWED_ACTIONS, ...partial }
}

export {
  FEATURES,
  FeatureUnavailableError,
  OSS_ENTITLEMENTS,
  OSS_NAV_ITEMS,
  hasFeature,
  requireFeature,
} from './edition'
export type { EditionId, EditionNavItem, Entitlements, Feature, HitlyEdition } from './edition'
