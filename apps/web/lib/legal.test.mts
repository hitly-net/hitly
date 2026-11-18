import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

await import('./test/preload.mjs')

const {
  LEGAL_ROUTES,
  LEGAL_PAGE_PATHS,
  LEGAL_FOOTER_COPY,
  SUPPORT_EMAIL,
  loadLegalDoc,
  headingSlugger,
} = await import('@/lib/legal')
const { MARKETING_ROUTES, buildSitemap, buildRobots, absoluteUrl } = await import('@/lib/site')
const { WEB_REDIRECTS } = await import('../next.config.mjs')

const FILES = [
  'privacy',
  'terms',
  'aup',
  'dpa',
  'subprocessors',
  'account-deletion',
  'legal-notice',
] as const

const CONTENT_DIR = join(process.cwd(), 'content', 'legal')

/** Case-sensitive markers Legal forbids on published pages. */
const FORBIDDEN_EXACT = ['®', 'INTERNAL', '[CONFIRM', '[VAT']
/** Case-insensitive internal-host words Legal forbids. */
const FORBIDDEN_WORDS = ['cloud-test', 'interweb', 'n8n', 'spark', 'qnap']
const RFC1918 = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/

function assertClean(text: string, where: string) {
  for (const marker of FORBIDDEN_EXACT) {
    assert.ok(!text.includes(marker), `${where} must not contain "${marker}"`)
  }
  for (const word of FORBIDDEN_WORDS) {
    assert.ok(
      !new RegExp(`\\b${word}\\b`, 'i').test(text),
      `${where} must not mention "${word}"`,
    )
  }
  const ip = RFC1918.exec(text)
  assert.ok(!ip, `${where} must not contain an RFC1918 IP (found ${ip?.[0]})`)
}

test('every legal document exists and has frontmatter with title and route', () => {
  for (const file of FILES) {
    assert.ok(existsSync(join(CONTENT_DIR, `${file}.md`)), `content/legal/${file}.md missing`)
    const doc = loadLegalDoc(file)
    assert.ok(doc.title.length > 0, `${file}: frontmatter title`)
    assert.equal(doc.route, LEGAL_ROUTES[file], `${file}: frontmatter route`)
    assert.ok(doc.body.trim().startsWith('# '), `${file}: body starts with an h1`)
  }
})

test('published legal texts contain no forbidden markers, hosts or private IPs', () => {
  for (const file of FILES) {
    assertClean(readFileSync(join(CONTENT_DIR, `${file}.md`), 'utf8'), `${file}.md`)
  }
})

test('legal-notice ships the approved VAT number', () => {
  const doc = loadLegalDoc('legal-notice')
  assert.match(doc.body, /VAT number: GB 420056447/)
  assert.ok(!doc.body.includes('delete this line'), 'placeholder line replaced')
})

test('unfilled authoring placeholders stay hidden, not published', () => {
  // [VERSION] / [EFFECTIVE DATE] in frontmatter must parse to null so the
  // renderer omits the line instead of printing the raw placeholder.
  for (const file of FILES) {
    const doc = loadLegalDoc(file)
    assert.equal(doc.version, null, `${file}: [VERSION] must not render`)
    assert.equal(doc.effective, null, `${file}: [EFFECTIVE DATE] must not render`)
  }
  // Known body placeholders Legal still needs to fill (tracked in the
  // RESULT): they must be exactly this set — no new ones silently ship.
  const found = new Set<string>()
  for (const file of FILES) {
    const body = loadLegalDoc(file).body
    for (const m of body.matchAll(/\[[A-Z][A-Z0-9 ]{2,}\]/g)) found.add(m[0])
  }
  assert.deepEqual(
    [...found].sort(),
    ['[ICO REGISTRATION NUMBER]', '[SUPPORT TICKET RETENTION]'],
    'unexpected placeholder set — update the RESULT file and Legal',
  )
  // Standalone placeholder lines (e.g. "Last updated: [EFFECTIVE DATE]")
  // are authoring markers and must be stripped, not published.
  assert.ok(
    !loadLegalDoc('subprocessors').body.includes('Last updated: ['),
    'subprocessors: standalone placeholder line stripped',
  )
})

test('heading anchors match GitHub slugs so /terms#6-billing-terms resolves', () => {
  const slugger = headingSlugger()
  assert.equal(slugger.slug('6. Billing Terms'), '6-billing-terms')
  // Duplicate headings get GitHub's -1 suffix (per-document instance).
  const dup = headingSlugger()
  dup.slug('Contact')
  assert.equal(dup.slug('Contact'), 'contact-1')
})

test('MARKETING_ROUTES and the sitemap include all seven legal routes', () => {
  for (const path of LEGAL_PAGE_PATHS) {
    assert.ok((MARKETING_ROUTES as readonly string[]).includes(path), `MARKETING_ROUTES: ${path}`)
  }
  const urls = new Set(buildSitemap().map((entry: { url: string }) => entry.url))
  for (const path of LEGAL_PAGE_PATHS) {
    assert.ok(urls.has(absoluteUrl(path)), `sitemap: ${path}`)
  }
  // /terms/billing is now a redirect: it must leave the sitemap.
  assert.ok(!urls.has(absoluteUrl('/terms/billing')), 'redirect target stays out of the sitemap')
})

test('robots.txt does not disallow any legal route', () => {
  const robots = buildRobots()
  const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules
  const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow ?? '']
  for (const path of LEGAL_PAGE_PATHS) {
    assert.ok(!disallow.includes(path), `robots must allow ${path}`)
  }
})

test('the terms/billing redirect is a 30x to the billing anchor on /terms', async () => {
  const entry = WEB_REDIRECTS.find((r: { source: string }) => r.source === '/terms/billing')
  assert.ok(entry, 'redirect for /terms/billing must exist')
  assert.equal(entry.destination, '/terms#6-billing-terms')
  assert.equal(entry.permanent, false, 'must be a temporary 30x, not a permanent 301')
})

test('footer copy matches the Legal-approved legal notice line', () => {
  const body = loadLegalDoc('legal-notice').body
  const quote = body
    .split('\n')
    .find((line: string) => line.trim().startsWith('> ©'))
  assert.ok(quote, 'legal notice must carry the footer quote line')
  // The quote is "© ... Corby NN18 9EZ. · Terms · Privacy · ..."
  assert.equal(LEGAL_FOOTER_COPY, quote.trim().slice(2).split(' · ')[0])
  for (const label of ['Terms', 'Privacy', 'AUP', 'DPA', 'Subprocessors', 'Account deletion', 'Legal notice']) {
    assert.ok(quote.includes(`· ${label} `) || quote.endsWith(label), `footer quote must name ${label}`)
  }
  assert.ok(quote.includes(SUPPORT_EMAIL), 'footer quote must carry the support address')
})
