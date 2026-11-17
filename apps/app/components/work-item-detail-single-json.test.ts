/**
 * The item (approval) detail page must render a single JSON panel: the
 * "View original request" panel. The old separate "Full JSON" disclosure is
 * gone; the fields it showed that the create-once request does not (redacted
 * origin reference, effective metadata bag) live in the collapsed "Raw stored
 * view" toggle inside that panel. This source pin keeps a second JSON panel
 * from creeping back into the detail screen.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

test('detail screen: single JSON panel (no Full JSON, raw stored view inside original-request panel)', () => {
  const detailSrc = fs.readFileSync(path.join(dir, 'work-item-detail.tsx'), 'utf8')
  const panelSrc = fs.readFileSync(path.join(dir, 'original-request-panel.tsx'), 'utf8')
  const pageSrc = fs.readFileSync(path.join(dir, '..', 'lib', 'work-item-page.ts'), 'utf8')

  // No separate Full JSON panel on the detail screen.
  assert.doesNotMatch(detailSrc, /JsonDisclosure/, 'detail screen must not render JsonDisclosure')
  assert.doesNotMatch(detailSrc, /Full JSON/, 'detail screen must not mention Full JSON')

  // Exactly one JSON panel: the original-request panel, fed the extra stored fields.
  assert.equal(detailSrc.match(/<OriginalRequestPanel/g)?.length, 1)
  assert.match(detailSrc, /<OriginalRequestPanel approvalId=\{page\.id\} rawStoredView=\{page\.rawStoredView\} \/>/)

  // The panel keeps hashes, Copy and Download, and adds the collapsed raw stored view.
  assert.match(panelSrc, /payloadHash/)
  assert.match(panelSrc, /argsHash/)
  assert.match(panelSrc, /Copy/)
  assert.match(panelSrc, /Download \(JSON\)/)
  assert.match(panelSrc, /Raw stored view/)
  assert.match(panelSrc, /aria-expanded=\{rawViewOpen\}/, 'raw stored view must be a collapsed-by-default toggle')
  assert.match(panelSrc, /redactedRequestJson\(rawStoredView\)/, 'raw stored view must be redacted like the original request')

  // The loader exposes only the extra (non-envelope) fields, redacted.
  assert.match(pageSrc, /rawStoredView: Record<string, unknown>/)
  assert.doesNotMatch(pageSrc, /jsonDisclosure/, 'the old full-JSON DTO field must be gone')
})
