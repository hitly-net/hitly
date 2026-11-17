/**
 * The mobile item detail screen must show a single JSON panel (the args
 * block); there is no "Full JSON" panel and no "View original request"
 * panel on mobile. This pins that no second JSON disclosure creeps in.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const mobileRoot = path.resolve(dir, '..', '..', '..')

function sources(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) out.set(p, fs.readFileSync(p, 'utf8'))
    }
  }
  walk(path.join(mobileRoot, 'app'))
  walk(path.join(mobileRoot, 'src'))
  return out
}

test('mobile: no "Full JSON" panel anywhere in the app', () => {
  for (const [file, src] of sources()) {
    assert.equal(src.includes('Full JSON'), false, `${path.relative(mobileRoot, file)} must not render a Full JSON panel`)
  }
})

test('mobile: detail screen keeps its single JSON block (args only)', () => {
  const screenSrc = fs.readFileSync(path.join(mobileRoot, 'app', 'inbox', '[id].tsx'), 'utf8')
  assert.match(screenSrc, /<ArgsBlock args=\{detail\.envelope\.action\.args\} \/>/, 'args block is the single JSON view')
  // Exactly ONE JSON block: a second <ArgsBlock> (a second JSON disclosure) must go red.
  const jsonBlocks = screenSrc.match(/<ArgsBlock\b/g) ?? []
  assert.equal(jsonBlocks.length, 1, 'detail screen must render exactly one JSON block (ArgsBlock)')
  assert.doesNotMatch(screenSrc, /payloadHash|argsHash|original-request|OriginalRequest/, 'detail screen carries no original-request panel')
})
