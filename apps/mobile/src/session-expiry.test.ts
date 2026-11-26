import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The mobile suite has no React renderer (see native-push.test.ts), so the
// expired-session flow is pinned at the source level: the client must be
// wired to clear the stored session on 401, and the clear must cover token,
// user and workspace state while keeping the chosen instance.

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'providers', 'SessionProvider.tsx'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('client is built with an onUnauthorized handler guarded on token identity', () => {
  assert.match(
    code,
    /onUnauthorized: \(\) => \{\s*if \(tokenRef\.current === token\) void clearSession\(\)/,
    'every authenticated 401 must route into clearSession, but only for the token the user still holds',
  )
  assert.match(code, /const tokenRef = useRef<string \| null>\(token\)/)
  assert.match(code, /tokenRef\.current = token/)
})

test('clearSession drops token, user, selected workspace and workspace list', () => {
  const clear = code.match(/const clearSession = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*\]\)/)
  assert.ok(clear, 'clearSession must exist as a stable callback')
  assert.match(clear[0], /await persistAuth\(null, null\)/)
  assert.match(clear[0], /await persistWorkspace\(null\)/)
  assert.match(clear[0], /setWorkspaces\(\[\]\)/)
  // The sign-in screen still needs the chosen Cloud/hosted instance.
  assert.doesNotMatch(clear[0], /INSTANCE_KEY|persistInstance/)
})

test('the clears behind clearSession delete the persisted session keys', () => {
  assert.match(code, /else await deleteItem\(TOKEN_KEY\)/)
  assert.match(code, /else await deleteItem\(USER_KEY\)/)
  assert.match(code, /else await deleteItem\(WORKSPACE_KEY\)/)
})

test('signOut reuses clearSession so manual sign-out and expiry behave the same', () => {
  assert.match(
    code,
    /const signOut = useCallback\(async \(\) => \{\s*await clearSession\(\)/,
  )
})
