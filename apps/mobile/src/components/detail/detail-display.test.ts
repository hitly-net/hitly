import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

test('source: decided ask_user detail shows the answer, hides empty payload, titles the question', () => {
  const headerSrc = fs.readFileSync(path.join(dir, 'StatusHeader.tsx'), 'utf8')
  const argsSrc = fs.readFileSync(path.join(dir, 'ArgsBlock.tsx'), 'utf8')
  const historySrc = fs.readFileSync(path.join(dir, 'DecisionHistory.tsx'), 'utf8')
  const screenSrc = fs.readFileSync(path.join(dir, '../../../app/inbox/[id].tsx'), 'utf8')
  assert.match(headerSrc, /workItemTitle\(detail\.envelope\.prompt, detail\.actionName\)/, 'title must be the question, not the raw tool name')
  assert.match(argsSrc, /isEmptyPayload\(args\)/, 'empty payload box must be hidden')
  assert.match(historySrc, /formatTypedAnswer/, 'decided items must render the typed answer')
  assert.match(screenSrc, /answer=\{detail\.answer\}/, 'detail screen must pass the session GET answer through')
  assert.match(screenSrc, /answerSchema=\{detail\.answerSchema/, 'detail screen must pass the stored schema through')
})
