import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../app')

/**
 * Session guards: every signed-in page must run a server-side session check
 * that redirects to /login when the session is not valid, not merely when a
 * cookie is absent. Accepted patterns are the existing helpers from
 * lib/context (requireSessionUser / getAppContext / withAppTenant) and
 * lib/project-page (requireVisibleProject, built on withAppTenant).
 */
const GUARDED_PAGES = [
  'inbox/page.tsx',
  'inbox/[id]/page.tsx',
  'settings/security/page.tsx',
  'settings/notifications/page.tsx',
  'settings/billing/invoices/page.tsx',
  'projects/page.tsx',
  'projects/[id]/page.tsx',
  'projects/[id]/channels/page.tsx',
  'projects/[id]/config/page.tsx',
  'projects/[id]/logs/page.tsx',
  'projects/[id]/people/page.tsx',
  'projects/[id]/rules/page.tsx',
  'projects/[id]/item/[itemId]/page.tsx',
  'audit/page.tsx',
  'settings/profile/page.tsx',
  'settings/billing/page.tsx',
  'settings/team/page.tsx',
  'settings/workspace/page.tsx',
]

describe('signed-in pages guard the session', () => {
  for (const rel of GUARDED_PAGES) {
    it(`${rel} checks the session server-side`, () => {
      const source = fs.readFileSync(path.join(appDir, rel), 'utf-8')
      assert.match(
        source,
        /(requireSessionUser|requireVisibleProject|withAppTenant|getAppContext)/,
        `${rel} must check the session via lib/context (or lib/project-page), so an invalid session redirects to /login`
      )
    })
  }
})
