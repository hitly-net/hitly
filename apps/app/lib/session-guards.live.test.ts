import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * LIVE guarded-page tests: the real page server components are called with
 * no session available (no database is configured under test, so the session
 * lookup resolves to "no session") and must redirect to /login. The page
 * modules and the redirect from next/navigation run for real — nothing is
 * stubbed except the environment.
 */

type PageComponent = (props?: { params?: Promise<Record<string, string>> }) => Promise<unknown>

const pages: Array<{ title: string; module: string; props?: { params?: Promise<Record<string, string>> } }> = [
  { title: 'settings/security', module: '../app/settings/security/page' },
  { title: 'settings/notifications', module: '../app/settings/notifications/page' },
  { title: 'settings/billing/invoices', module: '../app/settings/billing/invoices/page' },
  { title: 'inbox/[id]', module: '../app/inbox/[id]/page', props: { params: Promise.resolve({ id: 'nope' }) } },
  {
    title: 'projects/[id]/item/[itemId]',
    module: '../app/projects/[id]/item/[itemId]/page',
    props: { params: Promise.resolve({ id: 'nope', itemId: 'nope' }) },
  },
  { title: 'settings/profile', module: '../app/settings/profile/page' },
]

describe('guarded pages redirect to /login without a session', () => {
  for (const { title, module, props } of pages) {
    it(`${title} redirects`, async () => {
      const { default: page } = (await import(module)) as { default: PageComponent }
      await assert.rejects(
        () => page(props),
        (error: unknown) => {
          const detail = `${(error as { digest?: string })?.digest ?? ''} ${(error as Error)?.message ?? ''}`
          assert.match(detail, /NEXT_REDIRECT/, `${title} must throw the redirect signal`)
          assert.match(detail, /\/login/, `${title} must redirect to /login, got: ${detail}`)
          return true
        },
      )
    })
  }
})
