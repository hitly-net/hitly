/**
 * Render tests for the GA legal pages.
 *
 * The page components under app/ are thin compositions (SiteHeader +
 * LegalDoc + SiteFooter + marketingMeta), so the content itself is
 * render-tested through LegalDoc/SiteFooter (the static-render equivalent
 * of a 200) and the page files are pinned by source, mirroring
 * lib/cloud-page.test.mts. Pages can't be imported under tsx directly:
 * they pull in lib/site -> fumadocs .source/server.ts (top-level await),
 * which tsx's CJS transform rejects (see lib/test/preload.mjs).
 *
 * Run with: yarn workspace @hitly/web test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LEGAL_FOOTER_COPY, SUPPORT_EMAIL, type LegalDocFile } from '@/lib/legal'
import { LegalDoc } from './legal-doc'
import { LEGAL_FOOTER_LINKS, SiteFooter } from './site-chrome'

// Components compiled outside the app's tsconfig under tsx use the classic
// JSX runtime (same shim as pricing.test.tsx).
Object.assign(globalThis, { React })

const DOCS: ReadonlyArray<{
  file: LegalDocFile
  title: string
  expectText: string
}> = [
  { file: 'privacy', title: 'Privacy Notice', expectText: 'Privacy Notice' },
  { file: 'terms', title: 'Terms of Service', expectText: 'HITLy™ Cloud Terms of Service' },
  { file: 'aup', title: 'Acceptable Use Policy', expectText: 'Acceptable Use Policy' },
  { file: 'dpa', title: 'Data Processing Agreement', expectText: 'Data Processing Agreement' },
  { file: 'subprocessors', title: 'Subprocessors', expectText: 'Subprocessor' },
  { file: 'account-deletion', title: 'Account deletion and data requests', expectText: 'make a data request' },
  { file: 'legal-notice', title: 'Legal notice', expectText: 'Metaspan Ltd' },
]

const PAGE_FILES: ReadonlyArray<{ path: string; file: LegalDocFile; title: string }> = [
  { path: 'app/privacy/page.tsx', file: 'privacy', title: 'Privacy Notice' },
  { path: 'app/terms/page.tsx', file: 'terms', title: 'Terms of Service' },
  { path: 'app/aup/page.tsx', file: 'aup', title: 'Acceptable Use Policy' },
  { path: 'app/dpa/page.tsx', file: 'dpa', title: 'Data Processing Agreement' },
  { path: 'app/subprocessors/page.tsx', file: 'subprocessors', title: 'Subprocessors' },
  { path: 'app/account-deletion/page.tsx', file: 'account-deletion', title: 'Account deletion and data requests' },
  { path: 'app/legal/page.tsx', file: 'legal-notice', title: 'Legal notice' },
]

for (const doc of DOCS) {
  test(`/${doc.file} renders 200-equivalent with its title`, () => {
    const html = renderToStaticMarkup(React.createElement(LegalDoc, { file: doc.file }))
    assert.ok(html.length > 1500, `${doc.file}: substantial render`)
    assert.match(html, /<h1 id="[^"]+"/, `${doc.file}: anchored h1`)
    assert.ok(html.includes(doc.expectText), `${doc.file}: shows "${doc.expectText}"`)
  })
}

for (const page of PAGE_FILES) {
  test(`${page.path}: composes header, legal doc, footer with the right metadata`, () => {
    const source = readFileSync(join(process.cwd(), page.path), 'utf8')
    assert.match(source, /^export const metadata = marketingMeta\(\{$/m, `${page.path}: marketingMeta`)
    assert.match(source, new RegExp(`title: '${page.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',`), `${page.path}: title`)
    assert.match(source, new RegExp(`<LegalDoc file="${page.file}" />`), `${page.path}: renders the legal doc`)
    assert.match(source, /<SiteHeader \/>/, `${page.path}: site header`)
    assert.match(source, /<SiteFooter \/>/, `${page.path}: site footer`)
  })
}

test('the terms doc anchors section 6 as #6-billing-terms', () => {
  const html = renderToStaticMarkup(React.createElement(LegalDoc, { file: 'terms' }))
  assert.match(html, /<h2 id="6-billing-terms"/)
  assert.ok(html.includes('Billing Terms'))
})

test('the legal notice page ships the approved VAT number', () => {
  const html = renderToStaticMarkup(React.createElement(LegalDoc, { file: 'legal-notice' }))
  assert.ok(html.includes('VAT number: GB 420056447'))
})

test('every legal render is free of forbidden content', () => {
  for (const doc of DOCS) {
    let html = renderToStaticMarkup(React.createElement(LegalDoc, { file: doc.file }))
    // URL/hostname/webhook forms of n8n are banned on every page without
    // exception (r9.7 approves exactly one n8n mention: the waitlist row
    // on /subprocessors, which the HTML form check still sees).
    for (const re of [/\bn8n[._-]\w+/i, /https?:\/\/\S*n8n\S*/i, /\bn8n\.io\b/i]) {
      assert.ok(!re.test(html), `${doc.file}: must not render an n8n URL/hostname form`)
    }
    if (doc.file === 'subprocessors') {
      // Strip ONLY the Legal-approved waitlist row before the word ban;
      // any other n8n mention still fails the scan below.
      const approvedCell = /<td[^>]*>n8n \(self-hosted\)<\/td>/g
      const matches = html.match(approvedCell) ?? []
      assert.equal(matches.length, 1, 'subprocessors: exactly the approved n8n row renders')
      html = html.replace(approvedCell, '')
    }
    for (const marker of ['®', '[CONFIRM', '[VAT']) {
      assert.ok(!html.includes(marker), `${doc.file}: must not render "${marker}"`)
    }
    assert.ok(!/INTERNAL/.test(html), `${doc.file}: must not render INTERNAL`)
    for (const word of ['cloud-test', 'interweb', 'spark', 'qnap', 'n8n']) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(html), `${doc.file}: must not mention ${word}`)
    }
    assert.ok(
      !/\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/.test(html),
      `${doc.file}: no RFC1918 IPs`,
    )
  }
})

test('the site footer carries the legal line, all seven links and support', () => {
  const html = renderToStaticMarkup(React.createElement(SiteFooter))
  assert.ok(html.includes('© 2026 Metaspan Ltd'), 'footer carries the legal-notice copy')
  assert.ok(html.includes('13641200'), 'footer names the company number')
  for (const link of LEGAL_FOOTER_LINKS) {
    assert.ok(html.includes(`href="${link.href}"`), `footer links ${link.href}`)
  }
  assert.equal(LEGAL_FOOTER_LINKS.length, 7, 'exactly the seven legal pages')
  assert.ok(html.includes(`mailto:${SUPPORT_EMAIL}`), 'footer links support@hitly.net')
  assert.ok(LEGAL_FOOTER_COPY.startsWith('© 2026 Metaspan Ltd'))
})
