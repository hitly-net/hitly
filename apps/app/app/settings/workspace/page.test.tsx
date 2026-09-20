/**
 * Regression test for issue #67: workspace settings form must remount when workspace changes
 * to properly apply new defaultValue props.
 * Run with: yarn test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('workspace settings form has key={workspace.id} to force remount on workspace change', async () => {
  const pagePath = join(__dirname, 'page.tsx')
  const content = await readFile(pagePath, 'utf-8')

  // Verify the form element includes key={workspace.id}
  const formMatch = content.match(/<form[^>]*key={workspace\.id}[^>]*>/)
  assert.ok(
    formMatch,
    'Form element must have key={workspace.id} to remount when workspace changes. ' +
    'Without this key, defaultValue props on uncontrolled inputs will not re-apply after soft navigation.',
  )
})

test('workspace exporters section has key={workspace.id} to refresh on workspace change', async () => {
  const pagePath = join(__dirname, 'page.tsx')
  const content = await readFile(pagePath, 'utf-8')

  // Find the exporters section div and verify it has key={workspace.id}
  // The section starts with "Workspace Exporters" heading
  const exportersSectionMatch = content.match(/<div[^>]*key={workspace\.id}[^>]*>\s*<h2[^>]*>Workspace Exporters<\/h2>/)
  assert.ok(
    exportersSectionMatch,
    'Workspace Exporters section must have key={workspace.id} to refresh endpoints list when workspace changes. ' +
    'listOtelEndpoints is workspace-scoped and must bind to the new workspace.',
  )
})
