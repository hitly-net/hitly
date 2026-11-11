import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'NativePushProvider.tsx'), 'utf8')
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

test('native push registers with projectId and unregisters on sign-out', () => {
  assert.match(code, /getExpoPushTokenAsync\(\{ projectId \}\)/)
  assert.match(code, /registerPushToken/)
  assert.match(code, /unregisterPushToken/)
  assert.match(code, /addPushTokenListener/)
  assert.match(code, /parsePushData/)
  assert.match(code, /setAppBadge/)
  assert.match(code, /setNotificationChannelAsync/)
  assert.match(code, /name: 'HITLy'/)
})
