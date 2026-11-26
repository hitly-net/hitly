import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attemptSquashMerge, parsePrUrl, type GitHubApi } from './merge.ts'

const PR = { owner: 'hitly-net', repo: 'hitly', number: 201 }

function gh(responses: Record<string, unknown>): GitHubApi & { calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  return {
    calls,
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      const key = `${method} ${path}`
      if (!(key in responses)) throw new Error(`unstubbed: ${key}`)
      const response = responses[key] as Record<string, unknown>
      if ('__throw' in response) throw new Error(String(response.__throw))
      return response
    },
  }
}

test('parsePrUrl extracts owner/repo/number, rejects foreign hosts', () => {
  assert.deepEqual(parsePrUrl('https://github.com/hitly-net/hitly/pull/201'), PR)
  assert.equal(parsePrUrl('https://gitlab.com/hitly-net/hitly/-/merge_requests/9'), null)
  assert.equal(parsePrUrl('not a url'), null)
})

test('squash merge sends merge_method=squash with the pinned head SHA', async () => {
  const api = gh({
    'GET /repos/hitly-net/hitly/pulls/201': { merged: false, head: { sha: 'abc123' }, mergeable: true },
    'PUT /repos/hitly-net/hitly/pulls/201/merge': { merged: true, sha: 'abc123' },
  })
  const result = await attemptSquashMerge({ api, pr: PR, expectedHeadSha: 'abc123', token: 'ghp_test' })
  assert.equal(result.merged, true)
  const mergeCall = api.calls.find((c) => c.method === 'PUT')!
  assert.equal((mergeCall.body as { merge_method: string }).merge_method, 'squash')
  assert.equal((mergeCall.body as { sha: string }).sha, 'abc123')
})

test('head SHA drift blocks the merge — verdict was for an older commit', async () => {
  const api = gh({
    'GET /repos/hitly-net/hitly/pulls/201': { merged: false, head: { sha: 'def456' }, mergeable: true },
  })
  const result = await attemptSquashMerge({ api, pr: PR, expectedHeadSha: 'abc123', token: 'ghp_test' })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /sha|head|drift/i)
  assert.equal(api.calls.some((c) => c.method === 'PUT'), false)
})

test('already-merged PR is reported, not re-merged', async () => {
  const api = gh({
    'GET /repos/hitly-net/hitly/pulls/201': { merged: true, head: { sha: 'abc123' } },
  })
  const result = await attemptSquashMerge({ api, pr: PR, expectedHeadSha: 'abc123', token: 'ghp_test' })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /already/i)
  assert.equal(api.calls.some((c) => c.method === 'PUT'), false)
})

test('mergeable=false blocks the merge', async () => {
  const api = gh({
    'GET /repos/hitly-net/hitly/pulls/201': { merged: false, head: { sha: 'abc123' }, mergeable: false },
  })
  const result = await attemptSquashMerge({ api, pr: PR, expectedHeadSha: 'abc123', token: 'ghp_test' })
  assert.equal(result.merged, false)
  assert.equal(api.calls.some((c) => c.method === 'PUT'), false)
})

test('missing GitHub token means NO merge attempt — merge-ready is recorded and that is all', async () => {
  // The merge module must not be constructed at all without a token; this mirrors
  // how apply wires it: attemptMerge is only invoked when config.githubToken exists.
  const api = gh({})
  const result = await attemptSquashMerge({ api, pr: PR, expectedHeadSha: 'abc123', token: undefined })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /token/i)
  assert.equal(api.calls.length, 0)
})

test('merge API errors surface as not-merged, never throw', async () => {
  const api = gh({
    'GET /repos/hitly-net/hitly/pulls/201': { merged: false, head: { sha: 'abc123' }, mergeable: true },
    'PUT /repos/hitly-net/hitly/pulls/201/merge': { __throw: '405 Method Not Allowed' },
  })
  const result = await attemptSquashMerge({ api, pr: PR, expectedHeadSha: 'abc123', token: 'ghp_test' })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /405|merge/i)
})
