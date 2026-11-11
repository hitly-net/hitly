import { test } from 'node:test'
import assert from 'node:assert/strict'

await import('./test/preload.mjs')

const { GET: llmsTxt } = await import('@/app/llms.txt/route.ts')
const { GET: llmsFullTxt } = await import('@/app/llms-full.txt/route.ts')
const { source, integrationsSource } = await import('@/lib/source')

const BANNED = [/cloud-test\.hitly\.net/, /\b10\.\d+\.\d+\.\d+\b/, /\b192\.168\.\d+\.\d+\b/, /\b172\.(1[6-9]|2\d|3[01])\.\d+\.\d+\b/]

async function bodyOf(responsePromise: Response | Promise<Response>) {
  const response = await responsePromise
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/markdown/)
  return response.text()
}

test('GET /llms.txt indexes every docs and integrations page from source', async () => {
  const body = await bodyOf(llmsTxt())
  assert.match(body, /^# HITLy/m)
  for (const page of [...source.getPages(), ...integrationsSource.getPages()]) {
    const url = `https://hitly.net${page.url.replace(/\/$/, '')}`
    assert.ok(body.includes(url), `llms.txt missing ${url}`)
  }
})

test('GET /llms-full.txt contains the full text of every docs page', async () => {
  const body = await bodyOf(llmsFullTxt())
  for (const page of [...source.getPages(), ...integrationsSource.getPages()]) {
    const header = `# ${page.data.title} (https://hitly.net${page.url.replace(/\/$/, '')})`
    assert.ok(body.includes(header), `llms-full.txt missing section for ${page.url}`)
  }
})

test('llms entries are generated, so /docs/mcp appears once its MDX lands (PR #131)', async () => {
  // The index and full text are built from the fumadocs source at request
  // time; nothing hardcodes the page list. When content/docs/mcp.mdx (with
  // its meta.json entry) merges, both files pick it up automatically.
  const hasMcpPage = source.getPages().some((page: { url: string }) => page.url.replace(/\/$/, '') === '/docs/mcp')
  const index = await bodyOf(llmsTxt())
  if (hasMcpPage) {
    assert.ok(index.includes('https://hitly.net/docs/mcp'))
  } else {
    // Guard the generator contract instead: a page currently absent from
    // source must be absent from the index (proves it is source-driven).
    assert.ok(!index.includes('https://hitly.net/docs/mcp'))
    assert.ok(index.includes('https://hitly.net/docs/api'))
  }
})

test('llms output exposes no internal hosts or private IPs', async () => {
  const bodies = [await bodyOf(llmsTxt()), await bodyOf(llmsFullTxt())]
  for (const body of bodies) {
    for (const pattern of BANNED) assert.ok(!pattern.test(body), `forbidden match: ${pattern}`)
  }
})

test('llms.txt links to the agent guide, MCP docs and the sitemap', async () => {
  const body = await bodyOf(llmsTxt())
  assert.ok(body.includes('https://hitly.net/agents.md'), 'llms.txt missing /agents.md link')
  assert.ok(body.includes('https://hitly.net/docs/mcp'), 'llms.txt missing /docs/mcp link')
  assert.ok(body.includes('https://hitly.net/sitemap.xml'), 'llms.txt missing sitemap link')
})
