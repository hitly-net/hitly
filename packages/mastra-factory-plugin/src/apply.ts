import type { ApplyOutcome, ApprovalSnapshot, Gate } from './types.ts'

export interface ApplyDeps {
  gates: Record<Gate, boolean>
  mergeAfterAccept: boolean
  answerParked(args: {
    sessionId: string
    orgId?: string
    userId?: string
    toolCallId?: string
    decision: 'approve' | 'decline'
    reason: string
  }): Promise<void>
  signalSession(args: { sessionId: string; threadId?: string; message: string }): Promise<void>
  markMergeReady(args: { approvalId: string; prUrl?: string; headSha?: string }): Promise<void>
  attemptMerge(args: { prUrl?: string; headSha?: string }): Promise<{ merged: boolean; reason?: string }>
  recordEvent(eventId: string): Promise<void>
  alreadyApplied(key: string): Promise<boolean>
  markApplied(key: string): Promise<void>
}

export async function applyDecision(_snapshot: ApprovalSnapshot, _deps: ApplyDeps): Promise<ApplyOutcome> {
  throw new Error('not implemented')
}
