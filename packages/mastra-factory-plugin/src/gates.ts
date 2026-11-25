import type { ApprovalRequest, Gate, GateSession, PluginRuntimeConfig } from './types.ts'

export const GATE_METADATA_KEY = 'net.hitly/gate'
export const RESUME_PATH = '/api/integrations/hitly/resume'

export const METADATA_KEYS = {
  gate: 'net.hitly/gate',
  sessionId: 'net.hitly/factory/session-id',
  threadId: 'net.hitly/factory/thread-id',
  projectId: 'net.hitly/factory/project-id',
  toolCallId: 'net.hitly/factory/tool-call-id',
  orgId: 'net.hitly/factory/org-id',
  userId: 'net.hitly/factory/user-id',
  headSha: 'net.hitly/factory/head-sha',
  prUrl: 'net.hitly/factory/pr-url',
} as const

export interface HitlyClientLike {
  createApproval(body: Record<string, unknown>, idempotencyKey: string): Promise<{ id: string; status: string }>
}

export function detectGate(_toolName: string, _gates: Record<Gate, boolean>): Gate | null {
  throw new Error('not implemented')
}

export function buildApprovalRequest(_args: {
  gate: Gate
  toolCallId: string
  session: GateSession
  input: unknown
  output: unknown
  pr?: { url: string; headSha?: string }
  config: PluginRuntimeConfig
}): ApprovalRequest {
  throw new Error('not implemented')
}
