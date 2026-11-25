export interface PrRef {
  owner: string
  repo: string
  number: number
}

export interface GitHubApi {
  request(method: string, path: string, body?: unknown): Promise<unknown>
}

export function parsePrUrl(_url: string): PrRef | null {
  throw new Error('not implemented')
}

export async function attemptSquashMerge(_args: {
  api: GitHubApi
  pr: PrRef
  expectedHeadSha: string
  token?: string
}): Promise<{ merged: boolean; reason?: string }> {
  throw new Error('not implemented')
}
