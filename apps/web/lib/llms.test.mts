import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  assert.match(
    body,
    /^- \[MCP server docs\]\(https:\/\/hitly\.net\/docs\/mcp\)/m,
    'llms.txt must carry its own /docs/mcp entry',
  )
  assert.ok(body.includes('https://hitly.net/sitemap.xml'), 'llms.txt missing sitemap link')
})

test('every docs and integrations page exposes processed markdown', async () => {
  // Contract pin for /llms-full.txt: it is assembled from
  // page.data.getText('processed'), which THROWS unless
  // postprocess.includeProcessedMarkdown is enabled in source.config.ts.
  // fumadocs-mdx 14.x can also degrade silently (its node test loader
  // rewrites the shared compiled config per worker; see PR "fix: llms.txt
  // build on main"), so assert the processed text for every page directly
  // instead of only through the route bodies.
  const pages = [...source.getPages(), ...integrationsSource.getPages()]
  assert.ok(pages.length > 0, 'expected at least one docs or integrations page')
  for (const page of pages) {
    const processed = await page.data.getText('processed')
    assert.equal(typeof processed, 'string', `processed markdown missing for ${page.url}`)
    assert.ok(processed.trim().length > 0, `processed markdown empty for ${page.url}`)
  }
})

test('source.config.ts keeps processed markdown wired into both collections', () => {
  // Static tripwire: the runtime pin above can only fail once a page is
  // requested; this one pins the config itself (flag + wiring) against
  // drive-by edits to source.config.ts.
  const config = readFileSync(new URL('../source.config.ts', import.meta.url), 'utf-8')
  assert.match(config, /includeProcessedMarkdown:\s*true/)
  assert.match(config, /docs:\s*processedMarkdown/, 'processedMarkdown must be wired into every defineDocs collection')
})
