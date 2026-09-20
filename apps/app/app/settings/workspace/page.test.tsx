/**
 * Regression test for issue #67: workspace settings form must remount when workspace changes
 * to properly apply new defaultValue props.
 * Run with: yarn test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('workspace settings page has exactly one key={workspace.id} wrapper to force remount', async () => {
  const pagePath = join(__dirname, 'page.tsx')
  const content = await readFile(pagePath, 'utf-8')

  // Find all occurrences of key={workspace.id}
  const keyMatches = content.match(/key={workspace\.id}/g) || []
  
  assert.strictEqual(
    keyMatches.length,
    1,
    `Expected exactly 1 occurrence of key={workspace.id}, found ${keyMatches.length}. ` +
    'React keys must be unique among siblings - duplicate keys break reconciliation. ' +
    'Use a single wrapper div with key={workspace.id} around all content that needs to remount.',
  )

  // Verify the wrapper contains both the form and exporters section
  const wrapperMatch = content.match(/<div key={workspace\.id}>[\s\S]*?<h1[^>]*>Workspace<\/h1>[\s\S]*?<form[\s\S]*?<\/form>[\s\S]*?Workspace Exporters[\s\S]*?<\/div>\s*<\/div>/)
  assert.ok(
    wrapperMatch,
    'The key={workspace.id} wrapper must contain both the settings form and the exporters section. ' +
    'Without this wrapper, defaultValue props on uncontrolled inputs will not re-apply after soft navigation, ' +
    'and workspace-scoped OTEL endpoints will not refresh.',
  )
})
