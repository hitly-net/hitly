import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createHitlyClient, probeInstance } from '../api/hitly-client'
import { CLOUD_BASE_URL } from '../config'
import { deleteItem, getItem, setItem } from '../storage'
import type { AttentionLink, InstanceConfig, SessionUser, WorkspaceRow } from '../types'

const INSTANCE_KEY = 'hitly.instance'
const TOKEN_KEY = 'hitly.token'
const USER_KEY = 'hitly.user'
const WORKSPACE_KEY = 'hitly.workspaceId'
const PENDING_KEY = 'hitly.pendingLink'

type SessionContextValue = {
  ready: boolean
  instance: InstanceConfig | null
  token: string | null
  user: SessionUser | null
  workspaceId: string | null
  workspaces: WorkspaceRow[]
  pendingLink: AttentionLink | null
  mismatch: AttentionLink | null
  client: ReturnType<typeof createHitlyClient> | null
  chooseCloud: () => Promise<void>
  chooseHosted: (url: string) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signUp: (name: string, email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  setWorkspace: (id: string) => Promise<void>
  refreshWorkspaces: () => Promise<void>
  setPendingLink: (link: AttentionLink | null) => Promise<void>
  consumePendingLink: () => Promise<AttentionLink | null>
  clearMismatch: () => void
  resolveAttentionLink: (link: AttentionLink) => Promise<'open' | 'login' | 'mismatch'>
}

const SessionContext = createContext<SessionContextValue | null>(null)

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await getItem(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [instance, setInstance] = useState<InstanceConfig | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([])
  const [pendingLink, setPendingLinkState] = useState<AttentionLink | null>(null)
  const [mismatch, setMismatch] = useState<AttentionLink | null>(null)

  const persistInstance = useCallback(async (next: InstanceConfig | null) => {
    setInstance(next)
    if (next) await setItem(INSTANCE_KEY, JSON.stringify(next))
    else await deleteItem(INSTANCE_KEY)
  }, [])

  const persistAuth = useCallback(async (nextToken: string | null, nextUser: SessionUser | null) => {
    setToken(nextToken)
    setUser(nextUser)
    if (nextToken) await setItem(TOKEN_KEY, nextToken)
    else await deleteItem(TOKEN_KEY)
    if (nextUser) await setItem(USER_KEY, JSON.stringify(nextUser))
    else await deleteItem(USER_KEY)
  }, [])

  const persistWorkspace = useCallback(async (id: string | null) => {
    setWorkspaceId(id)
    if (id) await setItem(WORKSPACE_KEY, id)
    else await deleteItem(WORKSPACE_KEY)
  }, [])

  const setPendingLink = useCallback(async (link: AttentionLink | null) => {
    setPendingLinkState(link)
    if (link) await setItem(PENDING_KEY, JSON.stringify(link))
    else await deleteItem(PENDING_KEY)
  }, [])

  const client = useMemo(() => {
    if (!instance) return null
    return createHitlyClient({ baseUrl: instance.baseUrl, token, workspaceId })
  }, [instance, token, workspaceId])

  const refreshWorkspaces = useCallback(
    async (api = client) => {
      if (!api || !token) {
        setWorkspaces([])
        return
      }
      const data = await api.workspaces()
      setWorkspaces(data.workspaces)
      if (data.currentId && data.currentId !== workspaceId) await persistWorkspace(data.currentId)
    },
    [client, persistWorkspace, token, workspaceId],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const storedInstance = await readJson<InstanceConfig>(INSTANCE_KEY)
      const storedToken = await getItem(TOKEN_KEY)
      const storedUser = await readJson<SessionUser>(USER_KEY)
      const storedWorkspace = await getItem(WORKSPACE_KEY)
      const storedPending = await readJson<AttentionLink>(PENDING_KEY)
      if (cancelled) return
      setInstance(storedInstance)
      setToken(storedToken)
      setUser(storedUser)
      setWorkspaceId(storedWorkspace)
      setPendingLinkState(storedPending)
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!ready || !client || !token) return
    refreshWorkspaces(client).catch(() => undefined)
  }, [client, ready, refreshWorkspaces, token])

  const chooseCloud = useCallback(async () => {
    await persistInstance({ baseUrl: CLOUD_BASE_URL, label: 'Hitly Cloud' })
  }, [persistInstance])

  const chooseHosted = useCallback(
    async (url: string) => {
      const next = await probeInstance(url)
      await persistInstance(next)
    },
    [persistInstance],
  )

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!instance) throw new Error('Choose Cloud or a hosted URL first')
      const api = createHitlyClient({ baseUrl: instance.baseUrl })
      const data = await api.signIn(email, password)
      await persistAuth(data.token, data.user)
    },
    [instance, persistAuth],
  )

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      if (!instance) throw new Error('Choose Cloud or a hosted URL first')
      const api = createHitlyClient({ baseUrl: instance.baseUrl })
      const data = await api.signUp(name, email, password)
      await persistAuth(data.token, data.user)
    },
    [instance, persistAuth],
  )

  const signOut = useCallback(async () => {
    await persistAuth(null, null)
    await persistWorkspace(null)
    setWorkspaces([])
  }, [persistAuth, persistWorkspace])

  const setWorkspace = useCallback(
    async (id: string) => {
      if (!client) return
      await client.setWorkspace(id)
      await persistWorkspace(id)
    },
    [client, persistWorkspace],
  )

  const consumePendingLink = useCallback(async () => {
    const link = pendingLink
    await setPendingLink(null)
    return link
  }, [pendingLink, setPendingLink])

  const resolveAttentionLink = useCallback(
    async (link: AttentionLink): Promise<'open' | 'login' | 'mismatch'> => {
      if (link.instanceUrl && instance && !urlsMatch(instance.baseUrl, link.instanceUrl)) {
        setMismatch(link)
        return 'mismatch'
      }
      if (!token) {
        await setPendingLink(link)
        return 'login'
      }
      await setPendingLink(link)
      return 'open'
    },
    [instance, setPendingLink, token],
  )

  const value: SessionContextValue = {
    ready,
    instance,
    token,
    user,
    workspaceId,
    workspaces,
    pendingLink,
    mismatch,
    client,
    chooseCloud,
    chooseHosted,
    signIn,
    signUp,
    signOut,
    setWorkspace,
    refreshWorkspaces: () => refreshWorkspaces(),
    setPendingLink,
    consumePendingLink,
    clearMismatch: () => setMismatch(null),
    resolveAttentionLink,
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

function urlsMatch(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
  }
}

export function useSession() {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used within SessionProvider')
  return value
}
