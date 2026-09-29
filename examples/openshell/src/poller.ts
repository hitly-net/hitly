/**
 * OpenShell draft policy poller for HITLy
 *
 * Polls GetDraftPolicy for pending chunks and creates HITLy approvals.
 * Resume is handled by @hitly/plugin-openshell.
 */
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import fetch from 'node-fetch'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface PolicyChunk {
  chunk_id: string
  status: 'pending' | 'approved' | 'rejected'
  proposed_rule?: {
    kind?: string
    protocol?: string
    destination?: string
    port?: number
  }
  rationale?: string
  security_notes?: string[]
  hit_count?: number
  review_token?: string
}

interface Config {
  openshell: {
    gatewayAddr: string
    bearerToken: string
    workspace: string
    sandboxIds: string[]
  }
  hitly: {
    apiUrl: string
    apiKey: string
    projectId: string
  }
  pollIntervalMs: number
}

class OpenShellPoller {
  private config: Config
  private grpcClient: any
  private seenChunks = new Set<string>()

  constructor(config: Config) {
    this.config = config
    this.initGrpcClient()
  }

  private initGrpcClient() {
    const protoPath = join(dirname(dirname(dirname(__dirname))), 'packages/plugin-openshell/proto/openshell.proto')
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [join(dirname(dirname(dirname(__dirname))), 'packages/plugin-openshell/proto')],
    })

    const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any
    const OpenShellService = protoDescriptor.openshell.v1.OpenShell

    this.grpcClient = new OpenShellService(
      this.config.openshell.gatewayAddr,
      grpc.credentials.createInsecure()
    )
  }

  private async getDraftPolicy(sandbox: string): Promise<PolicyChunk[]> {
    return new Promise((resolve, reject) => {
      const metadata = new grpc.Metadata()
      metadata.add('authorization', `Bearer ${this.config.openshell.bearerToken}`)

      this.grpcClient.GetDraftPolicy(
        {
          workspace_scope: { workspace: this.config.openshell.workspace },
          sandbox,
          status_filter: 'pending',
        },
        metadata,
        (error: any, response: any) => {
          if (error) {
            reject(new Error(`GetDraftPolicy failed: ${error.message}`))
          } else {
            resolve(response.chunks || [])
          }
        }
      )
    })
  }

  private formatChunkContext(chunk: PolicyChunk, sandbox: string): string {
    let md = `# OpenShell Draft Policy Chunk\n\n`
    md += `**Workspace:** ${this.config.openshell.workspace}  \n`
    md += `**Sandbox:** ${sandbox}  \n`
    md += `**Chunk ID:** \`${chunk.chunk_id}\`\n\n`

    if (chunk.proposed_rule) {
      md += `## Proposed Network Policy Rule\n\n`
      const rule = chunk.proposed_rule
      md += `\`\`\`\n`
      if (rule.kind) md += `Kind: ${rule.kind}\n`
      if (rule.protocol) md += `Protocol: ${rule.protocol}\n`
      if (rule.destination) md += `Destination: ${rule.destination}\n`
      if (rule.port) md += `Port: ${rule.port}\n`
      md += `\`\`\`\n\n`
    }

    if (chunk.rationale) {
      md += `## Rationale\n\n${chunk.rationale}\n\n`
    }

    if (chunk.security_notes && chunk.security_notes.length > 0) {
      md += `## ⚠️ Security Notes\n\n`
      for (const note of chunk.security_notes) {
        md += `- ${note}\n`
      }
      md += `\n`
    }

    if (chunk.hit_count) {
      md += `**Observed requests:** ${chunk.hit_count}\n\n`
    }

    md += `---\n\n`
    md += `**HITLy** = decide + evidence (inbox, signed resume)  \n`
    md += `**OpenShell** = enforce (sandbox policy / kernel isolation)  \n`
    md += `**NVIDIA Sentry** = silicon watchdog`

    return md
  }

  private async createHitlyApproval(chunk: PolicyChunk, sandbox: string): Promise<void> {
    const { chunk_id: chunkId, review_token: reviewToken } = chunk

    if (!reviewToken) {
      console.warn(`[Poller] Chunk ${chunkId} has no review_token, skipping`)
      return
    }

    const payload = {
      plugin: 'openshell',
      projectId: this.config.hitly.projectId,
      workspace: this.config.openshell.workspace,
      sandbox,
      chunkId,
      reviewToken,
      gatewayAddr: this.config.openshell.gatewayAddr,
      actionName: 'approve-openshell-draft-chunk',
      args: {
        chunkId,
        sandbox,
        workspace: this.config.openshell.workspace,
        rule: chunk.proposed_rule,
        rationale: chunk.rationale,
        securityNotes: chunk.security_notes,
      },
      contextMarkdown: this.formatChunkContext(chunk, sandbox),
      allowedActions: {
        accept: true,
        reject: true,
        respond: true,
        edit: false,
        ignore: false,
        cancel: true,
      },
    }

    try {
      const response = await fetch(`${this.config.hitly.apiUrl}/api/v1/approvals`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.config.hitly.apiKey}`,
          'idempotency-key': `openshell:${sandbox}:${chunkId}`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`HITLy createApproval failed (${response.status}): ${text}`)
      }

      const result = await response.json() as { id: string }
      console.log(`[HITLy] Created approval ${result.id} for chunk ${chunkId} in sandbox ${sandbox}`)
    } catch (error) {
      console.error(`[HITLy] Failed to create approval for chunk ${chunkId}:`, error)
    }
  }

  private async pollSandbox(sandbox: string): Promise<void> {
    try {
      const chunks = await this.getDraftPolicy(sandbox)
      console.log(`[Poller] Sandbox ${sandbox}: ${chunks.length} pending chunks`)

      for (const chunk of chunks) {
        const key = `${sandbox}:${chunk.chunk_id}`
        if (!this.seenChunks.has(key)) {
          this.seenChunks.add(key)
          console.log(`[Poller] New pending chunk: ${chunk.chunk_id} in ${sandbox}`)
          await this.createHitlyApproval(chunk, sandbox)
        }
      }
    } catch (error) {
      console.error(`[Poller] Failed to poll sandbox ${sandbox}:`, error)
    }
  }

  private async poll(): Promise<void> {
    for (const sandbox of this.config.openshell.sandboxIds) {
      await this.pollSandbox(sandbox)
    }
  }

  async start(): Promise<void> {
    console.log('[Poller] Starting OpenShell HITLy poller')
    console.log(`[Poller] Gateway: ${this.config.openshell.gatewayAddr}`)
    console.log(`[Poller] HITLy API: ${this.config.hitly.apiUrl}`)
    console.log(`[Poller] Workspace: ${this.config.openshell.workspace}`)
    console.log(`[Poller] Sandboxes: ${this.config.openshell.sandboxIds.join(', ')}`)
    console.log(`[Poller] Poll interval: ${this.config.pollIntervalMs}ms`)
    console.log()
    console.log('Architecture:')
    console.log('  HITLy       = decide + evidence (inbox, signed resume, customer-owned sink)')
    console.log('  OpenShell   = enforce (sandbox policy / kernel isolation)')
    console.log('  NVIDIA Sentry = silicon/out-of-band watchdog')
    console.log()

    setInterval(() => {
      this.poll().catch((error) => {
        console.error('[Poller] Unhandled poll error:', error)
      })
    }, this.config.pollIntervalMs)

    await this.poll()
  }
}

function loadConfig(): Config {
  const required = (name: string): string => {
    const value = process.env[name]?.trim()
    if (!value) {
      throw new Error(`Missing required env var: ${name}`)
    }
    return value
  }

  const sandboxIds = required('OPENSHELL_SANDBOX_IDS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  if (sandboxIds.length === 0) {
    throw new Error('OPENSHELL_SANDBOX_IDS must contain at least one sandbox ID')
  }

  return {
    openshell: {
      gatewayAddr: required('OPENSHELL_GATEWAY_ADDR'),
      bearerToken: required('OPENSHELL_BEARER_TOKEN'),
      workspace: required('OPENSHELL_WORKSPACE'),
      sandboxIds,
    },
    hitly: {
      apiUrl: required('HITLY_API_URL'),
      apiKey: required('HITLY_API_KEY'),
      projectId: required('HITLY_PROJECT_ID'),
    },
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const poller = new OpenShellPoller(config)

  process.on('SIGINT', () => {
    console.log('\n[Poller] Shutting down...')
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\n[Poller] Shutting down...')
    process.exit(0)
  })

  poller.start().catch((error) => {
    console.error('[Poller] Fatal error:', error)
    process.exit(1)
  })
}
