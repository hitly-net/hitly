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
const { COMPLETED_RETENTION_DAYS, PRICING_LIMITS } = await import('@hitly/core')

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
/** Case-insensitive internal-host words Legal forbids on every page. */
const FORBIDDEN_WORDS = ['cloud-test', 'interweb', 'spark', 'qnap']
/**
 * n8n is banned on every page, with ONE exception: the exact
 * Legal-approved row in the subprocessor list (r9.6). Any other mention —
 * and every URL/hostname/webhook form, even in that file — fails.
 */
const APPROVED_N8N_ROW =
  '| n8n (self-hosted) | Receives early-access waitlist sign-ups |'
/** URL / hostname / webhook forms of n8n are banned everywhere, no exceptions. */
const N8N_URL_FORMS = [/\bn8n[._-]\w+/i, /https?:\/\/\S*n8n\S*/i, /\bn8n\.io\b/i]
const RFC1918 = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/

/** Remove the single Legal-approved n8n row (subprocessors only) before scanning. */
function withoutApprovedN8nRow(text: string, file: string): string {
  if (file !== 'subprocessors') return text
  const stripped = text.replace(APPROVED_N8N_ROW, '')
  assert.notEqual(stripped, text, 'subprocessors.md must carry the approved n8n waitlist row')
  return stripped
}

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
  // n8n: banned outright except the one approved subprocessor row.
  assert.ok(!/\bn8n\b/i.test(text), `${where} must not mention "n8n" (outside the approved subprocessor row)`)
  const ip = RFC1918.exec(text)
  assert.ok(!ip, `${where} must not contain an RFC1918 IP (found ${ip?.[0]})`)
}

/** Everything a page can put on the wire besides the markdown body. */
function renderedSurface(doc: { title: string; body: string; version: string | null; effective: string | null }): string {
  const footer = [doc.version ? `Version ${doc.version}` : null, doc.effective ? `Effective ${doc.effective}` : null]
    .filter(Boolean)
    .join(' · ')
  return [doc.title, doc.body, footer, LEGAL_FOOTER_COPY].join('\n')
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
    const raw = readFileSync(join(CONTENT_DIR, `${file}.md`), 'utf8')
    // URL/hostname/webhook forms of n8n are banned even in the file that
    // carries the approved row.
    for (const re of N8N_URL_FORMS) {
      const hit = re.exec(raw)
      assert.ok(!hit, `${file}.md must not contain an n8n URL/hostname form (found ${hit?.[0]})`)
    }
    assertClean(withoutApprovedN8nRow(raw, file), `${file}.md`)
  }
})

test('the subprocessor list carries the exact approved n8n row and nothing else', () => {
  const raw = readFileSync(join(CONTENT_DIR, 'subprocessors.md'), 'utf8')
  const occurrences = raw.split(APPROVED_N8N_ROW).length - 1
  assert.equal(occurrences, 1, 'exactly the approved n8n row, verbatim')
  // No other file may mention n8n at all.
  for (const file of FILES) {
    if (file === 'subprocessors') continue
    const text = readFileSync(join(CONTENT_DIR, `${file}.md`), 'utf8')
    assert.ok(!/\bn8n\b/i.test(text), `${file}.md must not mention n8n`)
  }
})

test('legal-notice ships the approved VAT number', () => {
  const doc = loadLegalDoc('legal-notice')
  assert.match(doc.body, /VAT number: GB 420056447/)
  assert.ok(!doc.body.includes('delete this line'), 'placeholder line replaced')
})

test('no bracket placeholder of any kind can ship, including [VERSION] and [EFFECTIVE DATE]', () => {
  // With no publish-time env set, the frontmatter placeholders must parse to
  // null so the renderer omits the lines instead of printing raw brackets.
  delete process.env.LEGAL_VERSION
  delete process.env.LEGAL_EFFECTIVE_DATE
  for (const file of FILES) {
    const doc = loadLegalDoc(file)
    assert.equal(doc.version, null, `${file}: [VERSION] must not render when LEGAL_VERSION is unset`)
    assert.equal(doc.effective, null, `${file}: [EFFECTIVE DATE] must not render when LEGAL_EFFECTIVE_DATE is unset`)
    const rendered = renderedSurface(doc)
    // r9.6 left NO open placeholders: any /\[[A-Z][A-Z0-9 ]+\]/ in what a
    // page renders is a regression (this kills re-inserting, e.g.,
    // [ICO REGISTRATION NUMBER]).
    const hit = /\[[A-Z][A-Z0-9 ]+\]/.exec(rendered)
    assert.ok(!hit, `${file}: rendered output must contain no bracket placeholder (found ${hit?.[0]})`)
    assert.ok(!rendered.includes('[VERSION]'), `${file}: rendered output must never contain [VERSION]`)
    assert.ok(!rendered.includes('[EFFECTIVE DATE]'), `${file}: rendered output must never contain [EFFECTIVE DATE]`)
  }
  // Standalone placeholder lines (e.g. "Last updated: [EFFECTIVE DATE]")
  // are authoring markers and must be stripped, not published.
  assert.ok(
    !loadLegalDoc('subprocessors').body.includes('Last updated: ['),
    'subprocessors: standalone placeholder line stripped',
  )
})

test('VERSION and EFFECTIVE DATE are publish-time values from LEGAL_VERSION / LEGAL_EFFECTIVE_DATE', () => {
  try {
    process.env.LEGAL_VERSION = 'r9.6'
    process.env.LEGAL_EFFECTIVE_DATE = '19 November 2026'
    for (const file of FILES) {
      const doc = loadLegalDoc(file)
      assert.equal(doc.version, 'r9.6', `${file}: version comes from LEGAL_VERSION`)
      assert.equal(doc.effective, '19 November 2026', `${file}: effective comes from LEGAL_EFFECTIVE_DATE`)
    }
    // An env value that is itself an unfilled bracket is treated as unset.
    process.env.LEGAL_VERSION = '[VERSION]'
    assert.equal(loadLegalDoc('terms').version, null, 'a bracket env value never renders')
  } finally {
    delete process.env.LEGAL_VERSION
    delete process.env.LEGAL_EFFECTIVE_DATE
  }
})

test('published completed-retention figures are pinned to COMPLETED_RETENTION_DAYS / PRICING_LIMITS', () => {
  // Text and code must not drift (Test MUST-2): the figures published in the
  // privacy retention table and DPA Annex 1 are asserted against the single
  // source of truth in @hitly/core, not hard-coded numbers.
  const expected = {
    solo: COMPLETED_RETENTION_DAYS.solo,
    pro: COMPLETED_RETENTION_DAYS.pro,
    team: COMPLETED_RETENTION_DAYS.team,
    enterprise: COMPLETED_RETENTION_DAYS.enterprise,
  }
  for (const plan of ['solo', 'pro', 'team', 'enterprise'] as const) {
    assert.equal(
      PRICING_LIMITS[plan].retentionDays,
      expected[plan],
      `PRICING_LIMITS.${plan}.retentionDays must equal COMPLETED_RETENTION_DAYS.${plan}`,
    )
  }
  const pattern =
    /Solo (\d+) days, Pro (\d+) days, Team (\d+) days, Enterprise ([\d,]+) days/g
  const expectedLine = `Solo ${expected.solo} days, Pro ${expected.pro} days, Team ${expected.team} days, Enterprise ${expected.enterprise.toLocaleString('en-US')} days`

  const privacy = loadLegalDoc('privacy').body
  const dpa = loadLegalDoc('dpa').body

  const privacyHits = [...privacy.matchAll(pattern)]
  assert.equal(privacyHits.length, 1, 'privacy retention table carries one completed-items figure line')
  assert.equal(privacyHits[0][0], expectedLine, 'privacy completed-item retention must equal COMPLETED_RETENTION_DAYS')

  const dpaHits = [...dpa.matchAll(pattern)]
  assert.equal(dpaHits.length, 1, 'DPA Annex 1 carries one completed-items figure line')
  assert.equal(dpaHits[0][0], expectedLine, 'DPA completed-item retention must equal COMPLETED_RETENTION_DAYS')
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
