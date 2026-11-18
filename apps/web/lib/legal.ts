import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import GithubSlugger from 'github-slugger'

/**
 * Legal documents for HITLy Cloud, published as marketing pages.
 *
 * The markdown files under content/legal/ are the Legal-approved texts.
 * They are rendered verbatim (headings get GitHub-compatible anchor ids so
 * deep links like /terms#6-billing-terms work). Do not edit the wording in
 * code; change the markdown files (via Legal review) instead.
 */
export type LegalDocFile =
  | 'privacy'
  | 'terms'
  | 'aup'
  | 'dpa'
  | 'subprocessors'
  | 'account-deletion'
  | 'legal-notice'

export type LegalDocMeta = {
  title: string
  route: string
  /** Document version, or null while the [VERSION] placeholder is unfilled. */
  version: string | null
  /** Effective date, or null while the [EFFECTIVE DATE] placeholder is unfilled. */
  effective: string | null
}

export type LegalDoc = LegalDocMeta & { body: string }

/** Route each legal document is published at. */
export const LEGAL_ROUTES: Record<LegalDocFile, string> = {
  privacy: '/privacy',
  terms: '/terms',
  aup: '/aup',
  dpa: '/dpa',
  subprocessors: '/subprocessors',
  'account-deletion': '/account-deletion',
  'legal-notice': '/legal',
}

/** The seven legal routes, in footer order. */
export const LEGAL_PAGE_PATHS = [
  '/terms',
  '/privacy',
  '/aup',
  '/dpa',
  '/subprocessors',
  '/account-deletion',
  '/legal',
] as const

/** Company line used in the site footer (from the Legal-approved legal notice). */
export const LEGAL_FOOTER_COPY =
  '© 2026 Metaspan Ltd, trading as HITLy™. Registered in England and Wales, company no. 13641200. Registered office: 3 Saxon Way West, Corby NN18 9EZ.'

/** Split around the company number so the footer can link it to Companies House. */
export const LEGAL_FOOTER_COMPANY_PREFIX =
  '© 2026 Metaspan Ltd, trading as HITLy™. Registered in England and Wales, company no.'
export const COMPANY_NUMBER = '13641200'
export const LEGAL_FOOTER_COMPANY_SUFFIX =
  '. Registered office: 3 Saxon Way West, Corby NN18 9EZ.'

export const SUPPORT_EMAIL = 'support@hitly.net'

/** An unfilled authoring placeholder such as [VERSION] or [ICO REGISTRATION NUMBER]. */
const PLACEHOLDER = /^\[[A-Z][A-Z0-9 ]*\]$/

/**
 * Publish-time values. Legal ships the texts with [VERSION] and
 * [EFFECTIVE DATE] as authoring placeholders; Ops sets the real values at
 * deploy time via the LEGAL_VERSION and LEGAL_EFFECTIVE_DATE environment
 * variables (set them at build and run time). When a variable is unset, the
 * corresponding line renders nothing — the raw bracket text is never
 * published. Dynamic key access keeps bundlers from inlining the value at
 * build time.
 */
function publishTimeValue(envName: string, frontmatterValue: string | null): string | null {
  const fromEnv = process.env[envName]?.trim()
  if (fromEnv && !PLACEHOLDER.test(fromEnv)) return fromEnv
  return frontmatterValue
}

/**
 * A standalone placeholder line (e.g. "Last updated: [EFFECTIVE DATE]" in
 * the subprocessor list) is an authoring marker, not content: drop the line
 * instead of publishing an unfilled bracket. Placeholders embedded inside
 * sentences stay verbatim for Legal to fill (listed in the publish RESULT).
 */
function stripPlaceholderLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !/^Last updated:\s*\[[A-Z][A-Z0-9 ]*\]\s*$/.test(line.trim()))
    .join('\n')
}

function parseFrontmatter(raw: string): { meta: LegalDocMeta; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(raw)
  const meta: LegalDocMeta = { title: '', route: '', version: null, effective: null }
  if (!match) return { meta, body: raw }
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*"?(.*?)"?\s*$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    const clean = value.trim()
    if (key === 'title') meta.title = clean
    else if (key === 'route') meta.route = clean
    else if (key === 'version') meta.version = PLACEHOLDER.test(clean) ? null : clean
    else if (key === 'effective') meta.effective = PLACEHOLDER.test(clean) ? null : clean
  }
  return { meta, body: raw.slice(match[0].length) }
}

/** Load a legal document from content/legal/<file>.md. */
export function loadLegalDoc(file: LegalDocFile): LegalDoc {
  const path = join(process.cwd(), 'content', 'legal', `${file}.md`)
  const raw = readFileSync(path, 'utf8')
  const { meta, body } = parseFrontmatter(raw)
  return {
    ...meta,
    version: publishTimeValue('LEGAL_VERSION', meta.version),
    effective: publishTimeValue('LEGAL_EFFECTIVE_DATE', meta.effective),
    body: stripPlaceholderLines(body),
  }
}

/**
 * GitHub-compatible heading slug (same algorithm the Legal team's anchors
 * are written against, e.g. "6. Billing Terms" -> "6-billing-terms").
 * Use one GithubSlugger instance per document so duplicate headings get
 * -1, -2 suffixes exactly like GitHub does.
 */
export function headingSlugger(): GithubSlugger {
  return new GithubSlugger()
}
