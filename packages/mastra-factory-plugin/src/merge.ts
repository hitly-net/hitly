export interface PrRef {
  owner: string
  repo: string
  number: number
}

export interface GitHubApi {
  request(method: string, path: string, body?: unknown): Promise<unknown>
}

const GITHUB_PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/

export function parsePrUrl(url: string): PrRef | null {
  const match = GITHUB_PR_URL.exec(url)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) }
}

/** GitHub REST client for the merge path. Token never leaves this module. */
export function createGitHubApi(token: string, baseUrl = 'https://api.github.com'): GitHubApi {
  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' ? JSON.stringify(payload) : response.statusText
        throw new Error(`GitHub API ${method} ${path} failed: ${response.status} ${detail}`)
      }
      return payload
    },
  }
}

/**
 * Squash-merge a PR via GitHub REST — the ONLY merge authority in this
 * plugin, reachable exclusively from the HITLy-gated apply path.
 *
 * Guards (contract-tested):
 * - No GitHub token → zero API calls; merge-ready is recorded and that's all.
 * - Head SHA is re-checked against the reviewed commit. Drift means the
 *   verdict was for an older head: refuse, do not merge.
 * - Already merged / not mergeable → refuse.
 * - GitHub errors surface as { merged: false }, never throw.
 */
export async function attemptSquashMerge(args: {
  api: GitHubApi
  pr: PrRef
  expectedHeadSha?: string
  token?: string
}): Promise<{ merged: boolean; reason?: string }> {
  const { api, pr, expectedHeadSha } = args
  // Any absent or empty token — key present as undefined or key omitted —
  // refuses with zero API calls. Production always passes the configured
  // token; there is no "proceed without a token" path to preserve.
  if (!args.token) {
    return { merged: false, reason: 'no GitHub token configured — merge-ready recorded only, a human must merge' }
  }
  const path = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`
  let pull: Record<string, unknown>
  try {
    pull = (await api.request('GET', path)) as Record<string, unknown>
  } catch (error) {
    return { merged: false, reason: `could not read pull request: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (pull.merged === true) {
    return { merged: false, reason: 'pull request was already merged' }
  }
  const currentHead = typeof pull.head === 'object' && pull.head !== null ? (pull.head as { sha?: unknown }).sha : undefined
  if (expectedHeadSha && currentHead !== expectedHeadSha) {
    return {
      merged: false,
      reason: `head sha drift: reviewed ${expectedHeadSha}, current ${String(currentHead)} — the verdict was for an older head, re-review required`,
    }
  }
  if (pull.mergeable === false) {
    return { merged: false, reason: 'pull request is not mergeable (conflicts or checks pending)' }
  }

  try {
    const result = (await api.request('PUT', `${path}/merge`, {
      sha: expectedHeadSha ?? currentHead,
      merge_method: 'squash',
    })) as Record<string, unknown>
    if (result?.merged === true) return { merged: true }
    return { merged: false, reason: 'GitHub reported the merge did not complete' }
  } catch (error) {
    return { merged: false, reason: `merge failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
