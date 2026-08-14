import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const HITLY_RESUME_CLAIM_VERSION = 1
export const HITLY_RESUME_TTL_SECONDS = 5 * 60

export type HitlyResumeClaim = {
  v: number
  runId: string
  stepId: string
  approvalId: string
  nonce: string
  iat: number
  exp: number
  sig: string
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`
}

function hmacHex(secret: string, payload: string) {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

function equalHex(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function unsignedClaim(claim: HitlyResumeClaim) {
  const { sig: _sig, ...rest } = claim
  return rest
}

export function signHitlyResume(args: {
  secret: string
  resumeData: Record<string, unknown>
  runId: string
  stepId?: string
  approvalId?: string
}): Record<string, unknown> {
  const iat = Math.floor(Date.now() / 1000)
  const claim: Omit<HitlyResumeClaim, 'sig'> = {
    v: HITLY_RESUME_CLAIM_VERSION,
    runId: args.runId,
    stepId: args.stepId ?? '',
    approvalId: args.approvalId ?? '',
    nonce: randomBytes(16).toString('hex'),
    iat,
    exp: iat + HITLY_RESUME_TTL_SECONDS,
  }
  const sig = hmacHex(args.secret, `${stable(claim)}.${stable(args.resumeData)}`)
  return { ...args.resumeData, hitly: { ...claim, sig } }
}

/** Mastra Zod `resumeSchema` strips unknown keys — use `.passthrough()` so `hitly` survives. */
export function verifyHitlyResume(
  resumeData: unknown,
  args?: { secret?: string; runId?: string; required?: boolean },
): void {
  const secret = args?.secret ?? process.env.HITLY_RESUME_SECRET ?? ''
  const required = args?.required ?? Boolean(secret)
  const record = resumeData !== null && typeof resumeData === 'object' ? (resumeData as Record<string, unknown>) : null
  const claim = record?.hitly

  if (!secret) {
    if (required) throw new Error('HITLY_RESUME_SECRET is not set; copy it from the Hitly project Config page.')
    return
  }
  if (!record || !claim || typeof claim !== 'object') {
    throw new Error('Hitly resume proof is missing; reject spoofed resume.')
  }

  const proof = claim as HitlyResumeClaim
  if (proof.v !== HITLY_RESUME_CLAIM_VERSION || typeof proof.sig !== 'string') {
    throw new Error('Hitly resume proof is invalid.')
  }
  if (typeof proof.exp !== 'number' || proof.exp * 1000 < Date.now()) {
    throw new Error('Hitly resume proof has expired.')
  }
  if (args?.runId && proof.runId !== args.runId) {
    throw new Error('Hitly resume proof runId does not match this run.')
  }

  const { hitly: _hitly, ...data } = record
  const expected = hmacHex(secret, `${stable(unsignedClaim(proof))}.${stable(data)}`)
  if (!equalHex(expected, proof.sig)) {
    throw new Error('Hitly resume proof signature does not match.')
  }
}
