import type { PluginRuntimeConfig } from './types.ts'

export interface SeenEventStore {
  check(eventId: string): boolean
  remember(eventId: string): void
}

export interface ApprovalAuthorityState {
  id: string
  status: string
  decision: string | null
  metadata: Record<string, unknown>
}

export interface ResumeDispatch {
  approvalId: string
  decision: string
  gate: string
  reason?: string
  editedArgs?: Record<string, unknown>
  response?: string
  metadata: Record<string, unknown>
}

export interface ResumeDeps {
  dedupe: SeenEventStore
  fetchApprovalState(approvalId: string): Promise<ApprovalAuthorityState>
  apply(cmd: ResumeDispatch): Promise<{ applied: boolean; reason?: string }>
  log?(level: string, message: string, meta?: Record<string, unknown>): void
}

export function handleResumeRequest(_args: {
  headers: Headers
  rawBody: string
  config: PluginRuntimeConfig
  deps: ResumeDeps
}, _nowSeconds?: number): Promise<Response> {
  throw new Error('not implemented')
}
