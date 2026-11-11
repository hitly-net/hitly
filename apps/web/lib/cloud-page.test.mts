import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

await import('./test/preload.mjs')

// /cloud must stay out of the index. #147 moved the page metadata into a
// component-free module (app/cloud/metadata.ts) exactly so discovery tests
// can pin it without importing React components; these tests pin both the
// metadata value and that the page actually uses it.
const { cloudMetadata } = await import('@/app/cloud/metadata.ts')

const pageSource = readFileSync(
  fileURLToPath(new URL('../app/cloud/page.tsx', import.meta.url)),
  'utf8',
)

test('cloud page metadata is noindex and no-follow', () => {
  assert.deepEqual(cloudMetadata.robots, { index: false, follow: false })
})

test('cloud page uses the noindex metadata and stays force-dynamic', () => {
  assert.match(
    pageSource,
    /^import \{ cloudMetadata \} from '\.\/metadata'$/m,
    'page must import the shared cloud metadata module',
  )
  assert.match(
    pageSource,
    /^export const metadata = cloudMetadata$/m,
    'page metadata must be the noindex cloudMetadata',
  )
  assert.match(
    pageSource,
    /^export const dynamic = 'force-dynamic'$/m,
    'page must stay force-dynamic',
  )
})
