/**
 * HITLy Gateway Interceptor (Reference Implementation)
 *
 * IMPORTANT: This is a TypeScript reference stub for demo purposes only.
 * The production interceptor will be implemented in Go by the OpenShell team
 * as a gRPC middleware in the OpenShell gateway codebase.
 *
 * This file demonstrates the interceptor logic for educational purposes.
 */

import fetch from 'node-fetch'

export interface HitlyInterceptorConfig {
  enabled: boolean
  hitlyApiUrl: string
  hitlyApiKey: string
  hitlyProjectId: string
  timeoutMs?: number
  failOpen?: boolean
}

export interface ApprovalStatus {
  id: string
  status: 'pending' | 'decided' | 'cancelled' | 'expired' | 'failed_resume'
  decision?: 'accept' | 'reject' | 'cancel' | 'edit' | 'ignore'
  runId?: string
}

export interface GrpcRequest {
  method: string
  workspace: string
  sandbox: string
  chunkId: string
}

export interface InterceptorResult {
  allowed: boolean
  reason?: string
  hitlyStatus?: string
  hitlyDecision?: string
}

/**
 * HITLy interceptor: verifies human decision exists before allowing draft chunk approval/rejection.
 */
export class HitlyInterceptor {
  private config: Required<HitlyInterceptorConfig>

  constructor(config: HitlyInterceptorConfig) {
    this.config = {
      ...config,
      timeoutMs: config.timeoutMs ?? 5000,
      failOpen: config.failOpen ?? false,
    }

    if (this.config.enabled) {
      this.validateConfig()
    }
  }

  private validateConfig(): void {
    if (!this.config.hitlyApiUrl) {
      throw new Error('HITLy interceptor: HITLY_API_URL is required when enabled')
    }
    if (!this.config.hitlyApiKey || !this.config.hitlyApiKey.startsWith('hitly_')) {
      throw new Error('HITLy interceptor: HITLY_API_KEY must start with "hitly_" when enabled')
    }
    if (!this.config.hitlyProjectId || !this.config.hitlyProjectId.startsWith('prj_')) {
      throw new Error('HITLy interceptor: HITLY_PROJECT_ID must start with "prj_" when enabled')
    }
  }

  /**
   * Intercept ApproveDraftChunk or RejectDraftChunk requests.
   * Returns { allowed: true } if the request should be allowed, or { allowed: false, reason } if denied.
   */
  async intercept(request: GrpcRequest): Promise<InterceptorResult> {
    if (!this.config.enabled) {
      return { allowed: true }
    }

    const { method, sandbox, chunkId } = request

    // Only intercept approve/reject methods
    if (method !== 'ApproveDraftChunk' && method !== 'RejectDraftChunk') {
      return { allowed: true }
    }

    // Query HITLy for matching approval
    const runId = `${sandbox}:${chunkId}`
    let approval: ApprovalStatus | null = null

    try {
      approval = await this.queryHitlyApproval(runId)
    } catch (error) {
      // HITLy API unreachable or error
      const message = error instanceof Error ? error.message : 'Unknown error'
      
      if (this.config.failOpen) {
        console.warn(`[HITLy Interceptor] FAIL-OPEN MODE: Allowing request despite error: ${message}`)
        return { allowed: true, reason: `HITLy API error (fail-open): ${message}` }
      } else {
        // Fail-closed: deny request
        return { 
          allowed: false, 
          reason: `HITLy API unreachable (fail-closed): ${message}` 
        }
      }
    }

    if (!approval) {
      return { 
        allowed: false, 
        reason: `No approval found for runId ${runId}` 
      }
    }

    // Apply decision matrix
    return this.applyDecisionMatrix(method, approval)
  }

  private async queryHitlyApproval(runId: string): Promise<ApprovalStatus | null> {
    const url = `${this.config.hitlyApiUrl}/api/v1/approvals/by-run-id?runId=${encodeURIComponent(runId)}&plugin=openshell`
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'authorization': `Bearer ${this.config.hitlyApiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
      })

      if (response.status === 404) {
        return null // No approval found
      }

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`HITLy API error (${response.status}): ${text}`)
      }

      const data = await response.json() as ApprovalStatus
      return data

    } catch (error) {
      if ((error as any).name === 'AbortError') {
        throw new Error(`HITLy API timeout after ${this.config.timeoutMs}ms`)
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private applyDecisionMatrix(method: string, approval: ApprovalStatus): InterceptorResult {
    const { status, decision } = approval

    // Deny if approval is still pending (awaiting human decision)
    if (status === 'pending') {
      return {
        allowed: false,
        reason: `Approval ${approval.id} is still pending (awaiting human decision)`,
        hitlyStatus: status,
      }
    }

    // Deny if approval is expired
    if (status === 'expired') {
      return {
        allowed: false,
        reason: `Approval ${approval.id} has expired`,
        hitlyStatus: status,
      }
    }

    // Deny if approval is cancelled without a decision
    if (status === 'cancelled' && decision !== 'cancel') {
      return {
        allowed: false,
        reason: `Approval ${approval.id} was cancelled without a decision`,
        hitlyStatus: status,
      }
    }

    // Allow decided or failed_resume (decision exists, resume may have failed but human chose)
    if (status === 'decided' || status === 'failed_resume') {
      if (!decision) {
        return {
          allowed: false,
          reason: `Approval ${approval.id} is ${status} but has no decision`,
          hitlyStatus: status,
        }
      }

      // Check decision matches gRPC method
      if (method === 'ApproveDraftChunk') {
        if (decision === 'accept') {
          return { allowed: true, hitlyStatus: status, hitlyDecision: decision }
        } else {
          return {
            allowed: false,
            reason: `Decision mismatch: HITLy decision is "${decision}", but gRPC method is ApproveDraftChunk (requires "accept")`,
            hitlyStatus: status,
            hitlyDecision: decision,
          }
        }
      } else if (method === 'RejectDraftChunk') {
        if (decision === 'reject' || decision === 'cancel') {
          return { allowed: true, hitlyStatus: status, hitlyDecision: decision }
        } else {
          return {
            allowed: false,
            reason: `Decision mismatch: HITLy decision is "${decision}", but gRPC method is RejectDraftChunk (requires "reject" or "cancel")`,
            hitlyStatus: status,
            hitlyDecision: decision,
          }
        }
      }
    }

    // Default deny (unknown status)
    return {
      allowed: false,
      reason: `Unknown approval status: ${status}`,
      hitlyStatus: status,
      hitlyDecision: decision,
    }
  }
}

/**
 * Load interceptor config from environment variables.
 */
export function loadInterceptorConfig(): HitlyInterceptorConfig {
  const enabled = process.env.OPENSHELL_HITLY_INTERCEPTOR_ENABLED === 'true' || 
                  process.env.OPENSHELL_HITLY_INTERCEPTOR_ENABLED === '1'

  if (!enabled) {
    return {
      enabled: false,
      hitlyApiUrl: '',
      hitlyApiKey: '',
      hitlyProjectId: '',
    }
  }

  return {
    enabled: true,
    hitlyApiUrl: process.env.OPENSHELL_HITLY_API_URL || '',
    hitlyApiKey: process.env.OPENSHELL_HITLY_API_KEY || '',
    hitlyProjectId: process.env.OPENSHELL_HITLY_PROJECT_ID || '',
    timeoutMs: parseInt(process.env.OPENSHELL_HITLY_INTERCEPTOR_TIMEOUT_MS || '5000', 10),
    failOpen: process.env.OPENSHELL_HITLY_INTERCEPTOR_FAIL_OPEN === 'true' ||
              process.env.OPENSHELL_HITLY_INTERCEPTOR_FAIL_OPEN === '1',
  }
}
