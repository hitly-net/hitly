/**
 * People tab (last-admin guard): the row that holds the project's only admin
 * must render its role select, Save and Remove disabled, each carrying the
 * explanatory tooltip, and must route the decision through the tested
 * isLastAdminRow helper (the server actions stay the real gate).
 * Run with: yarn test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

test('people page disables role change and Remove for the last admin', async () => {
  const content = await readFile(join(__dirname, 'page.tsx'), 'utf-8')

  assert.match(
    content,
    /isLastAdminRow\(person\.role, adminCount\)/,
    'the disabled decision must come from the tested isLastAdminRow helper',
  )
  assert.match(content, /const adminCount = people\.filter\(\(person\) => person\.role === 'admin'\)\.length/, 'admin count feeds the helper')

  // Role select, Save and Remove are all disabled for the last-admin row.
  const disabledCount = content.match(/disabled=\{lastAdmin\}/g)?.length ?? 0
  assert.equal(disabledCount, 3, 'role select, Save and Remove must all be disabled for the last admin')

  // Each disabled control carries the explanatory tooltip.
  const titleCount = content.match(/title=\{lastAdmin \? lastAdminHint : undefined\}/g)?.length ?? 0
  assert.equal(titleCount, 3, 'each disabled control must show the tooltip explaining why')
  assert.match(content, /Only admin on this project/, 'the tooltip explains the product rule')
})
