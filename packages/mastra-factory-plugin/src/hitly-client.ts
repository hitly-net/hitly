import type { ApprovalRef, ApprovalStatusValue } from './types.ts'

export interface HitlyClientConfig {
  hitlyBaseUrl: string
  hitlyApiKey: string
  projectId: string
  fetchImpl?: typeof fetch
}

export interface RemoteIntegrationConfig {
  gates: { plan: boolean; review: boolean; ask_user: boolean }
  mergeAfterAccept: boolean
}

export class IDEMPOTENCY_CONFLICT extends Error {
  constructor(message = 'HITLy idempotency conflict') {
    super(message)
    this.name = 'IDEMPOTENCY_CONFLICT'
  }
}

export class HitlyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'HitlyApiError'
  }
}

export class HitlyClient {
  constructor(_config: HitlyClientConfig) {
    throw new Error('not implemented')
  }
  async createApproval(_body: Record<string, unknown>, _idempotencyKey: string): Promise<ApprovalRef> {
    throw new Error('not implemented')
  }
  async getApproval(_id: string): Promise<{ id: string; status: ApprovalStatusValue; decision: string | null; metadata: Record<string, unknown> }> {
    throw new Error('not implemented')
  }
  async listPending(): Promise<{ approvals: Array<{ id: string; status: ApprovalStatusValue }> }> {
    throw new Error('not implemented')
  }
  async getIntegrationConfig(): Promise<RemoteIntegrationConfig> {
    throw new Error('not implemented')
  }
}
