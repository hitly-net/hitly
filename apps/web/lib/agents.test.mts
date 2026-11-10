import { test } from 'node:test'
import assert from 'node:assert/strict'

await import('./test/preload.mjs')

const { GET: agentsMd } = await import('@/app/agents.md/route.ts')
const { GET: agentsTxt } = await import('@/app/agents.txt/route.ts')

const BANNED = [/cloud-test\.hitly\.net/, /\b10\.\d+\.\d+\.\d+\b/, /\b192\.168\.\d+\.\d+\b/, /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/]

async function bodyOf(response: Response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/markdown/)
  return response.text()
}

test('GET /agents.md returns the agent guide with MCP details', async () => {
  const body = await bodyOf(agentsMd())
  assert.match(body, /^# HITLy — guide for AI agents/m)
  assert.match(body, /https:\/\/mcp\.hitly\.net\/mcp/)
  assert.match(body, /Authorization: Bearer <project API key>/)
  for (const tool of ['request_approval', 'ask_user', 'get_decision', 'list_pending']) {
    assert.match(body, new RegExp(`\`?${tool}\`?`), `missing tool: ${tool}`)
  }
  assert.match(body, /no decide tool/i)
  assert.match(body, /https:\/\/hitly\.net\/docs\/mcp/)
  assert.match(body, /https:\/\/hitly\.net\/llms\.txt/)
  assert.match(body, /https:\/\/hitly\.net\/llms-full\.txt/)
})

test('GET /agents.txt is the same content as /agents.md', async () => {
  const md = await bodyOf(agentsMd())
  const txt = await bodyOf(agentsTxt())
  assert.equal(txt, md)
})

test('agents guide exposes no internal hosts or private IPs', async () => {
  const body = await bodyOf(agentsMd())
  for (const pattern of BANNED) assert.ok(!pattern.test(body), `forbidden match: ${pattern}`)
})
