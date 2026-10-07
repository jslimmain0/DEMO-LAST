import { matchPath } from 'react-router-dom'

export const routePaths = {
  workspaces: '/workspaces', resources: '/resources',
  dashboard: '/flows', flow: '/flows/:id', executions: '/executions',
  mocks: '/mocks', mock: '/mocks/:id', protocols: '/protocols', protocol: '/protocols/:id',
  plugins: '/plugins', plugin: '/plugins/:id', admin: '/admin',
} as const

/** 앱의 명시적인 진입 공간이 브라우저에 남은 이전 선택보다 우선한다. */
export function initialWorkspace(search: string, desktop: boolean, saved: unknown): { origin: 'local' | 'server'; id: string } {
  const params = new URLSearchParams(search)
  const explicit = params.get('space')?.match(/^(local|server):(.+)$/)
  if (explicit) return { origin: explicit[1] as 'local' | 'server', id: explicit[2] }
  if (desktop && ['local', 'server'].includes(params.get('runtime') ?? '')) {
    const origin = params.get('runtime') as 'local' | 'server'
    return { origin, id: origin === 'local' ? 'local' : 'public' }
  }
  if (saved && typeof saved === 'object' && 'id' in saved && typeof saved.id === 'string' && saved.id &&
      'origin' in saved && (saved.origin === 'local' || saved.origin === 'server')) {
    return { origin: saved.origin, id: saved.id }
  }
  return { origin: desktop ? 'local' as const : 'server' as const, id: desktop ? 'local' : 'public' }
}

/** 첫 진입과 공간 쿼리 보충이 같은 경로로 이동하도록 정규화한다. */
export function workspaceLocation(pathname: string, search: string, hash = '') {
  return { pathname: Object.values(routePaths).some(path => matchPath(path, pathname)) ? pathname : routePaths.dashboard, search, hash }
}
