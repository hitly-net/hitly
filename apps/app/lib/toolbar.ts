export type ToolbarPage =
  | 'home'
  | 'inbox'
  | 'inbox-item'
  | 'projects'
  | 'project'
  | 'project-item'
  | 'audit'
  | 'other'

const PROJECT_TABS = ['config', 'people', 'rules', 'channels', 'logs'] as const

export function toolbarPage(pathname: string): ToolbarPage {
  if (pathname === '/') return 'home'
  if (pathname === '/inbox') return 'inbox'
  if (/^\/inbox\/[^/]+$/.test(pathname)) return 'inbox-item'
  if (pathname === '/projects') return 'projects'
  if (/^\/projects\/[^/]+\/item\/[^/]+$/.test(pathname)) return 'project-item'
  if (/^\/projects\/[^/]+/.test(pathname)) return 'project'
  if (pathname === '/audit') return 'audit'
  return 'other'
}

export function toolbarBackHref(pathname: string): string | null {
  const page = toolbarPage(pathname)
  if (page === 'inbox-item') return '/inbox'
  if (page === 'project') return '/projects'
  if (page === 'project-item') {
    const projectId = pathname.split('/')[2]
    return projectId ? `/projects/${projectId}` : '/projects'
  }
  return null
}

export function toolbarProjectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/projects\/([^/]+)/)
  return match?.[1] ?? null
}

export function toolbarWorkspaceHref(pathname: string): string {
  const page = toolbarPage(pathname)
  if (page === 'inbox' || page === 'inbox-item') return '/inbox'
  if (page === 'projects' || page === 'project' || page === 'project-item') return '/projects'
  if (page === 'audit') return '/audit'
  if (page === 'home') return '/'
  return pathname
}

function withProjectQuery(path: string, search: string, projectId: string | null) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (projectId) params.set('projectId', projectId)
  else params.delete('projectId')
  if (path === '/inbox' && !params.get('scope')) params.set('scope', 'all')
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export function toolbarProjectHref(pathname: string, search: string, projectId: string | null): string {
  const page = toolbarPage(pathname)

  if (page === 'home') return withProjectQuery('/', search, projectId)
  if (page === 'inbox' || page === 'inbox-item') return withProjectQuery('/inbox', search, projectId)
  if (page === 'audit') return withProjectQuery('/audit', search, projectId)

  if (page === 'project-item') {
    return projectId ? `/projects/${projectId}` : '/projects'
  }

  if (page === 'project') {
    if (!projectId) return '/projects'
    const tab = pathname.match(/^\/projects\/[^/]+\/(config|people|rules|channels|logs)$/)
    if (tab && (PROJECT_TABS as readonly string[]).includes(tab[1])) {
      return `/projects/${projectId}/${tab[1]}`
    }
    return `/projects/${projectId}`
  }

  if (page === 'projects' || page === 'other') {
    return projectId ? `/projects/${projectId}` : '/projects'
  }

  return projectId ? `/projects/${projectId}` : pathname
}
