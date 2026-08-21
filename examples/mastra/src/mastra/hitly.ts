import { notifyHitlyApproval, type HitlyApprovalStepConfig } from '@hitly/plugin-mastra'
import type { ApprovalAttachment, ExternalLink } from '@hitly/core'

export function hitlyConfig(): Pick<
  HitlyApprovalStepConfig,
  'apiUrl' | 'apiKey' | 'projectId' | 'mastraBaseUrl'
> {
  const apiKey = process.env.HITLY_API_KEY ?? ''
  const projectId = process.env.HITLY_PROJECT_ID ?? ''
  if (!apiKey || !projectId) {
    throw new Error(
      'Set HITLY_API_KEY and HITLY_PROJECT_ID in examples/mastra/.env (copy them from the HITLy project page).',
    )
  }
  return {
    apiUrl: process.env.HITLY_API_URL ?? 'http://localhost:3001',
    apiKey,
    projectId,
    mastraBaseUrl: process.env.MASTRA_BASE_URL ?? 'http://localhost:4111',
  }
}

export async function notifyHitly(args: {
  config: Omit<HitlyApprovalStepConfig, 'apiUrl' | 'apiKey' | 'projectId' | 'mastraBaseUrl'>
  runId: string
  contextMarkdown: string
  externalUrls?: Array<string | ExternalLink>
  attachments?: ApprovalAttachment[]
}) {
  await notifyHitlyApproval(
    { ...hitlyConfig(), ...args.config },
    {
      runId: args.runId,
      suspendPayload: {
        reason: args.contextMarkdown,
        contextMarkdown: args.contextMarkdown,
        externalUrls: args.externalUrls,
        attachments: args.attachments,
      },
      resumeSchema: { approved: { type: 'boolean' } },
    },
  )
}
