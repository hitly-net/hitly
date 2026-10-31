import type { Decision } from '@hitly/core'
import { WORKSPACE_HEADER, ORIGIN_HEADER } from './headers'
import type {
  ApprovalDetail,
  InboxSummary,
  InstanceConfig,
  ProjectConfig,
  ProjectRow,
  SessionUser,
  WorkItemRow,
  WorkspaceRow,
  WorkspaceSettings,
} from '../types'

export { WORKSPACE_HEADER }

type ClientOptions = {
  baseUrl: string
  token?: string | null
  workspaceId?: string | null
  /** Sent in `x-hitly-client` so the server labels evidence `client.channel` as mobile. */
  platform?: 'ios' | 'android'
  /** App version shown in `x-hitly-client` (server truncates/validates). */
  appVersion?: string
}

async function readError(response: Response) {
  const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string }
  return data.message ?? data.error ?? `Request failed (${response.status})`
}

export function createHitlyClient(options: ClientOptions) {
  const origin = (() => {
    try {
      return new URL(options.baseUrl).origin
    } catch {
      return options.baseUrl.replace(/\/+$/, '')
    }
  })()

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
      [ORIGIN_HEADER]: origin,
    }
    if (options.token) next.authorization = `Bearer ${options.token}`
    if (options.workspaceId) next[WORKSPACE_HEADER] = options.workspaceId
    // Device/channel hint for evidence (`hitly.evidence.v1` client field).
    // Parsed by apps/app/lib/request-client.ts; malformed values are ignored there.
    if (options.platform || options.appVersion) {
      const version = options.appVersion ?? 'unknown'
      next['x-hitly-client'] = options.platform
        ? `hitly-mobile/${version} (${options.platform})`
        : `hitly-mobile/${version}`
    }
    return next
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: { ...headers(), ...(init?.headers as Record<string, string> | undefined) },
    })
    if (!response.ok) throw new Error(await readError(response))
    return (await response.json()) as T
  }

  return {
    async health() {
      const response = await fetch(`${options.baseUrl}/api/v1/health`, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('Not a HITLy instance')
      const data = (await response.json()) as { ok?: boolean; product?: string }
      if (!data.ok || data.product !== 'hitly') throw new Error('Not a HITLy instance')
      return data
    },
    async signupStatus() {
      const response = await fetch(`${options.baseUrl}/api/v1/signup-status`, { headers: { accept: 'application/json' } })
      if (!response.ok) return { signupEnabled: true }
      const data = (await response.json()) as { signupEnabled?: boolean }
      return { signupEnabled: data.signupEnabled ?? true }
    },
    async signIn(email: string, password: string) {
      const data = await request<{ token: string; user: SessionUser }>('/api/auth/sign-in/email', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      return data
    },
    async signUp(name: string, email: string, password: string) {
      const data = await request<{ token: string; user: SessionUser }>('/api/auth/sign-up/email', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
      })
      return data
    },
    inbox(query?: { scope?: string; q?: string; projectId?: string }) {
      const params = new URLSearchParams()
      if (query?.scope) params.set('scope', query.scope)
      if (query?.q) params.set('q', query.q)
      if (query?.projectId) params.set('projectId', query.projectId)
      const suffix = params.toString() ? `?${params}` : ''
      return request<{ items: WorkItemRow[]; nextCursor: string | null }>(`/api/v1/inbox${suffix}`)
    },
    summary() {
      return request<InboxSummary>('/api/v1/inbox/summary')
    },
    approval(id: string) {
      return request<ApprovalDetail>(`/api/v1/approvals/${id}`)
    },
    /**
     * Record that this reviewer was FIRST shown the ask (hitl-spec 5.2).
     * Idempotent server-side: safe to call once per screen load; later calls
     * return the existing `presentedAt` without touching the evidence chain.
     */
    presented(id: string) {
      return request<{ id: string; presentedAt: string | null }>(`/api/v1/approvals/${id}/presented`, {
        method: 'POST',
      })
    },
    decide(id: string, body: { decision: Decision; editedArgs?: Record<string, unknown>; response?: string; reason?: string }) {
      return request(`/api/v1/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify(body) })
    },
    /** Record that this reviewer opened a context item (hitl-spec 3.7, client-reported opens). */
    open(id: string, ref: string) {
      return request<{ ok: true; ref: string; openedAt: string }>(`/api/v1/approvals/${id}/opens`, {
        method: 'POST',
        body: JSON.stringify({ ref }),
      })
    },
    retryResume(id: string) {
      return request(`/api/v1/approvals/${id}/retry-resume`, { method: 'POST' })
    },
    cancel(id: string) {
      return request(`/api/v1/approvals/${id}/cancel`, { method: 'POST' })
    },
    workspaces() {
      return request<{ workspaces: WorkspaceRow[]; currentId: string | null }>('/api/v1/workspaces')
    },
    setWorkspace(workspaceId: string) {
      return request<{ currentId: string }>('/api/v1/workspaces/current', {
        method: 'POST',
        body: JSON.stringify({ workspaceId }),
      })
    },
    workspace() {
      return request<WorkspaceSettings>('/api/v1/workspace')
    },
    updateWorkspace(body: { name: string; timezone: string; sla: string }) {
      return request<WorkspaceSettings>('/api/v1/workspace', { method: 'PATCH', body: JSON.stringify(body) })
    },
    projects() {
      return request<{ projects: ProjectRow[] }>('/api/v1/projects')
    },
    project(id: string) {
      return request<ProjectRow>(`/api/v1/projects/${id}`)
    },
    projectConfig(id: string) {
      return request<ProjectConfig>(`/api/v1/projects/${id}/config`)
    },
    updateProjectConfig(id: string, body: Partial<ProjectConfig> & { sla?: string; token?: string }) {
      return request<{ ok: true }>(`/api/v1/projects/${id}/config`, { method: 'PATCH', body: JSON.stringify(body) })
    },
    registerDevice(token: string, platform: 'ios' | 'android') {
      return request('/api/v1/devices', { method: 'POST', body: JSON.stringify({ token, platform }) })
    },
    unregisterDevice(token: string) {
      return request('/api/v1/devices', { method: 'DELETE', body: JSON.stringify({ token }) })
    },
  }
}

export async function probeInstance(baseUrl: string): Promise<InstanceConfig> {
  const client = createHitlyClient({ baseUrl })
  try {
    await client.health()
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        'Could not reach that origin. Confirm the HITLy server is running and allows this browser origin (CORS).',
      )
    }
    throw error
  }
  const host = new URL(baseUrl).host
  return { baseUrl, label: host }
}
