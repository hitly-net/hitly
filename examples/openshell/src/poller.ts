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
import { readFileSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

interface TlsConfig {
  ca?: string
  cert?: string
  key?: string
  sslTargetNameOverride?: string
  insecure?: boolean
}

/**
 * Load TLS material from file path or return as PEM string if already in PEM format.
 */
function loadTlsMaterial(pathOrPem: string): Buffer {
  const trimmed = pathOrPem.trim()
  if (trimmed.includes('-----BEGIN') && trimmed.includes('-----END')) {
    return Buffer.from(trimmed, 'utf-8')
  }
  return readFileSync(pathOrPem)
}

/**
 * Create gRPC channel credentials based on TLS configuration.
 * - If insecure=true: createInsecure (dev/test only, explicit opt-in)
 * - If tlsConfig provided: createSsl with CA + client cert/key for mTLS
 * - Otherwise: throw error (fail-closed, require explicit TLS or insecure flag)
 */
function createGrpcCredentials(tlsConfig?: TlsConfig): grpc.ChannelCredentials {
  if (tlsConfig?.insecure === true) {
    return grpc.credentials.createInsecure()
  }

  if (tlsConfig && (tlsConfig.ca || tlsConfig.cert || tlsConfig.key)) {
    const rootCerts = tlsConfig.ca ? loadTlsMaterial(tlsConfig.ca) : undefined
    const privateKey = tlsConfig.key ? loadTlsMaterial(tlsConfig.key) : undefined
    const certChain = tlsConfig.cert ? loadTlsMaterial(tlsConfig.cert) : undefined

    if ((certChain && !privateKey) || (!certChain && privateKey)) {
      throw new Error('TLS client cert and key must both be provided for mTLS')
    }

    return grpc.credentials.createSsl(rootCerts, privateKey, certChain)
  }

  throw new Error(
    'OpenShell poller requires TLS configuration (OPENSHELL_TLS_CA_FILE, OPENSHELL_TLS_CERT_FILE, OPENSHELL_TLS_KEY_FILE) or explicit insecure flag (OPENSHELL_TLS_INSECURE=1) for dev/test only'
  )
}

interface PolicyChunk {
  id: string
  status: 'pending' | 'approved' | 'rejected'
  rule_name?: string
  binary?: string
  proposed_rule?: {
    kind?: string
    protocol?: string
    destination?: string
    port?: number
    endpoints?: Array<{
      host?: string
      port?: number
      ports?: number[]
      protocol?: string
    }>
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
    tls?: TlsConfig
  }
  hitly: {
    apiUrl: string
    apiKey: string
    projectId: string
  }
  pollIntervalMs: number
}

/**
 * Format network policy rule destination for human readability.
 * Handles both legacy single destination field and modern endpoints array.
 */
function formatDestination(rule: PolicyChunk['proposed_rule']): string | null {
  if (!rule) return null
  
  // Legacy single destination field
  if (rule.destination) {
    const port = rule.port ? `:${rule.port}` : ''
    return `${rule.destination}${port}`
  }
  
  // Modern endpoints array
  if (rule.endpoints && rule.endpoints.length > 0) {
    const endpoint = rule.endpoints[0]
    const host = endpoint.host || '<host>'
    const ports = endpoint.ports && endpoint.ports.length > 0 
      ? endpoint.ports 
      : endpoint.port 
        ? [endpoint.port]
        : []
    
    if (ports.length === 0) return host
    if (ports.length === 1) return `${host}:${ports[0]}`
    return `${host}:${ports.join(',')}`
  }
  
  return null
}

/**
 * Build human-readable Markdown context for an OpenShell draft policy chunk.
 * Pure function for testability.
 */
export function buildChunkContextMarkdown(
  chunk: PolicyChunk, 
  sandbox: string, 
  workspace: string
): string {
  let md = `## Proposed Network Policy Rule\n\n`
  
  // Rule name (primary identifier for operators)
  if (chunk.rule_name) {
    md += `**Rule:** \`${chunk.rule_name}\`\n\n`
  }
  
  // Binary that triggered the request
  if (chunk.binary) {
    md += `**Binary:** \`${chunk.binary}\`\n\n`
  }
  
  // Destination (method + URL or host:port)
  const destination = formatDestination(chunk.proposed_rule)
  if (destination) {
    const protocol = chunk.proposed_rule?.protocol || 'tcp'
    const isL7 = ['rest', 'websocket', 'graphql', 'sql', 'json-rpc', 'mcp'].includes(protocol)
    
    if (isL7) {
      // L7 inspection: show as URL-like
      const scheme = protocol === 'rest' ? 'https' : protocol
      md += `**Destination:** \`${scheme}://${destination}\`\n\n`
    } else {
      // L4-only: show as host:port
      md += `**Destination:** \`${destination}\` (${protocol})\n\n`
    }
  }
  
  // Rationale (why this rule is needed)
  if (chunk.rationale) {
    md += `**Rationale:** ${chunk.rationale}\n\n`
  }
  
  // Hit count (how many times observed)
  if (chunk.hit_count && chunk.hit_count > 0) {
    md += `**Observed requests:** ${chunk.hit_count}\n\n`
  }
  
  // Security notes (warnings/concerns)
  if (chunk.security_notes && chunk.security_notes.length > 0) {
    md += `### ⚠️ Security Notes\n\n`
    for (const note of chunk.security_notes) {
      md += `- ${note}\n`
    }
    md += `\n`
  }
  
  // Metadata section (collapsible details)
  md += `<details>\n`
  md += `<summary>Metadata</summary>\n\n`
  md += `**Workspace:** ${workspace}  \n`
  md += `**Sandbox:** ${sandbox}  \n`
  md += `**Chunk ID:** \`${chunk.id}\`\n\n`
  md += `</details>\n\n`
  
  // Architecture footer
  md += `---\n\n`
  md += `**HITLy** = decide + evidence (inbox, signed resume)  \n`
  md += `**OpenShell** = enforce (sandbox policy / kernel isolation)  \n`
  md += `**NVIDIA Sentry** = silicon watchdog`
  
  return md
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

    const credentials = createGrpcCredentials(this.config.openshell.tls)

    const channelArgs: Record<string, any> = {}
    if (this.config.openshell.tls?.sslTargetNameOverride) {
      channelArgs['grpc.ssl_target_name_override'] = this.config.openshell.tls.sslTargetNameOverride
    }

    this.grpcClient = new OpenShellService(
      this.config.openshell.gatewayAddr,
      credentials,
      channelArgs
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
    return buildChunkContextMarkdown(chunk, sandbox, this.config.openshell.workspace)
  }

  private async createHitlyApproval(chunk: PolicyChunk, sandbox: string): Promise<void> {
    const { id: chunkId, review_token: reviewToken } = chunk

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
        const key = `${sandbox}:${chunk.id}`
        if (!this.seenChunks.has(key)) {
          this.seenChunks.add(key)
          console.log(`[Poller] New pending chunk: ${chunk.id} in ${sandbox}`)
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

  const optional = (name: string): string | undefined => {
    const value = process.env[name]?.trim()
    return value || undefined
  }

  const sandboxIds = required('OPENSHELL_SANDBOX_IDS')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  if (sandboxIds.length === 0) {
    throw new Error('OPENSHELL_SANDBOX_IDS must contain at least one sandbox ID')
  }

  // Normalize gateway address: remove https:// prefix if present
  let gatewayAddr = required('OPENSHELL_GATEWAY_ADDR')
  gatewayAddr = gatewayAddr.replace(/^https?:\/\//, '')

  // Load TLS configuration
  const tlsCa = optional('OPENSHELL_TLS_CA_FILE')
  const tlsCert = optional('OPENSHELL_TLS_CERT_FILE')
  const tlsKey = optional('OPENSHELL_TLS_KEY_FILE')
  const tlsSslTargetNameOverride = optional('OPENSHELL_TLS_SSL_TARGET_NAME_OVERRIDE')
  const tlsInsecure = process.env.OPENSHELL_TLS_INSECURE === '1' || process.env.OPENSHELL_TLS_INSECURE === 'true'

  const tlsConfig: TlsConfig | undefined = 
    tlsCa || tlsCert || tlsKey || tlsInsecure
      ? {
          ca: tlsCa,
          cert: tlsCert,
          key: tlsKey,
          sslTargetNameOverride: tlsSslTargetNameOverride,
          insecure: tlsInsecure,
        }
      : undefined

  return {
    openshell: {
      gatewayAddr,
      bearerToken: required('OPENSHELL_BEARER_TOKEN'),
      workspace: required('OPENSHELL_WORKSPACE'),
      sandboxIds,
      tls: tlsConfig,
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
