/**
 * Demo script for OpenShell adapter
 * Generates mock PolicyChunk data to show what the poller would process
 */
import { randomBytes } from 'node:crypto'

interface MockChunk {
  chunk_id: string
  status: 'pending'
  proposed_rule: {
    kind: string
    protocol: string
    destination: string
    port: number
  }
  rationale: string
  security_notes?: string[]
  hit_count: number
  review_token: string
}

function generateMockChunk(): MockChunk {
  const destinations = [
    'api.anthropic.com',
    'api.openai.com',
    'registry.npmjs.org',
    'github.com',
    'huggingface.co',
  ]

  const protocols = ['tcp', 'udp']
  const ports = [443, 80, 8080, 5432, 6379]

  return {
    chunk_id: `chunk_${randomBytes(8).toString('hex')}`,
    status: 'pending',
    proposed_rule: {
      kind: 'egress',
      protocol: protocols[Math.floor(Math.random() * protocols.length)],
      destination: destinations[Math.floor(Math.random() * destinations.length)],
      port: ports[Math.floor(Math.random() * ports.length)],
    },
    rationale: 'Agent observed repeated connection attempts to this destination. Approving would allow the sandbox to proceed with authenticated API calls.',
    security_notes: Math.random() > 0.7 ? ['External API access', 'Credentials required'] : undefined,
    hit_count: Math.floor(Math.random() * 50) + 1,
    review_token: `rt_${randomBytes(16).toString('hex')}`,
  }
}

async function main() {
  console.log('=== OpenShell HITLy Adapter Demo ===\n')

  console.log('Architecture:\n')
  console.log('  HITLy         = decide + evidence (inbox, signed resume, customer-owned sink)')
  console.log('  OpenShell     = enforce (sandbox policy / kernel isolation)')
  console.log('  NVIDIA Sentry = silicon/out-of-band watchdog\n')

  console.log('Flow:\n')
  console.log('  1. OpenShell agent triggers human_review_required draft chunk')
  console.log('  2. Poller calls GetDraftPolicy(pending) and finds new chunk')
  console.log('  3. Poller creates HITLy approval (idempotent by sandbox:chunkId)')
  console.log('  4. Reviewer decides in HITLy inbox')
  console.log('  5. HITLy calls @hitly/plugin-openshell resume')
  console.log('  6. Plugin calls ApproveDraftChunk or RejectDraftChunk')
  console.log('  7. Evidence emitted to configured sink\n')

  console.log('Mock pending chunks:\n')

  for (let i = 0; i < 3; i++) {
    const chunk = generateMockChunk()
    console.log(`Chunk ${i + 1}:`)
    console.log(`  ID: ${chunk.chunk_id}`)
    console.log(`  Rule: ${chunk.proposed_rule.kind} ${chunk.proposed_rule.protocol}://${chunk.proposed_rule.destination}:${chunk.proposed_rule.port}`)
    console.log(`  Rationale: ${chunk.rationale}`)
    if (chunk.security_notes) {
      console.log(`  Security Notes: ${chunk.security_notes.join(', ')}`)
    }
    console.log(`  Hit Count: ${chunk.hit_count}`)
    console.log(`  Review Token: ${chunk.review_token}`)
    console.log()
  }

  console.log('To run the poller:')
  console.log('  1. Copy .env.example to .env')
  console.log('  2. Fill in your OpenShell and HITLy credentials')
  console.log('  3. Run: yarn start\n')

  console.log('The poller will:')
  console.log('  - Poll GetDraftPolicy for configured OPENSHELL_SANDBOX_IDS')
  console.log('  - Create HITLy approvals for new pending chunks (idempotent)')
  console.log('  - HITLy calls plugin resume on decision')
  console.log('  - Plugin calls ApproveDraftChunk or RejectDraftChunk')
  console.log('  - Evidence emitted at each lifecycle stage\n')

  console.log('Scope:')
  console.log('  ✓ Only human_review_required / proposal_approval_mode=manual chunks')
  console.log('  ✗ Not every network denial (use OpenShell TUI for that)')
  console.log('  ✗ Not gateway interceptors (optional post_commit audit later)')
  console.log('  ✗ Not supervisor middleware')
}

main().catch((error) => {
  console.error('Demo error:', error)
  process.exit(1)
})
