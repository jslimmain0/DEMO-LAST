import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { hashKey, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { createApi, localApi, serverApi, type WorkspaceApi, type WorkspaceView } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { desktopApi } from '../auth/desktop'
import { workspaceLocation } from './routePaths'

export type WorkspaceOrigin = 'local' | 'server'
export interface WorkspaceRef extends WorkspaceView { origin: WorkspaceOrigin }
interface Scope {
  current: WorkspaceRef
  workspaces: WorkspaceRef[]
  api: WorkspaceApi
  scopeKey: string
  remoteKey: string
  connected: boolean
  login: string | null
  remoteError: boolean
  loading: boolean
  remoteLoading: boolean
  select: (id: string, origin?: WorkspaceOrigin) => void
  refresh: () => void
  agentApi: (origin: WorkspaceOrigin, workspaceId?: string) => WorkspaceApi
}
const WorkspaceContext = createContext<Scope | null>(null)
const storageKey = 'fl:workspace:selection'

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const desktop = !!auth.desktop
  const connection = useQuery({ queryKey: ['desktop', 'connection'], queryFn: desktopApi.connection, enabled: desktop, refetchInterval: 3000 })
  const connected = desktop ? (connection.data?.connected ?? auth.desktop?.connected ?? false) : true
  const serverUrl = connection.data?.serverUrl ?? auth.desktop?.serverUrl ?? window.location.origin
  const login = connection.data ? connection.data.login : auth.desktop?.login ?? null
  const remoteKey = `${serverUrl}:${login ?? auth.me?.username ?? ''}:${connected}`
  const local = useMemo(() => createApi(localApi), [])
  const remote = useMemo(() => createApi(desktop ? serverApi : localApi, 'public', serverUrl, desktop ? login : null), [desktop, serverUrl, login])
  const localSpaces = useQuery({ queryKey: ['workspace-catalog', 'local'], queryFn: local.workspacesApi.list, enabled: desktop })
  const remoteSpaces = useQuery({ queryKey: ['workspace-catalog', 'server', serverUrl, login, connected], queryFn: remote.workspacesApi.list, enabled: connected, refetchInterval: 15000, retry: false })
  const workspaces = useMemo<WorkspaceRef[]>(() => [
    ...(desktop ? (localSpaces.data ?? []).map(w => ({ ...w, origin: 'local' as const })) : []),
    ...(connected ? (remoteSpaces.data ?? []).map(w => ({ ...w, origin: 'server' as const })) : []),
  ], [desktop, connected, localSpaces.data, remoteSpaces.data])
  const [selection, setSelection] = useState<{ id: string; origin: WorkspaceOrigin }>(() => {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('space')?.match(/^(local|server):(.+)$/)
    if (fromUrl) return { origin: fromUrl[1] as WorkspaceOrigin, id: fromUrl[2] }
    if (desktop && params.get('runtime') === 'server') return { origin: 'server', id: 'public' }
    try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); if (saved?.id && ['local', 'server'].includes(saved.origin)) return saved } catch { /* private mode */ }
    return { id: desktop ? 'local' : 'public', origin: desktop ? 'local' : 'server' }
  })
  const fallback: WorkspaceRef = { id: desktop ? 'local' : 'public', name: desktop ? '개인 공간' : '공용', kind: desktop ? 'PERSONAL' : 'PUBLIC', myRole: 'OWNER', canManage: true, origin: desktop ? 'local' : 'server' }
  const urlSpace = new URLSearchParams(location.search).get('space')?.match(/^(local|server):(.+)$/)
  const requested = urlSpace ? { origin: urlSpace[1] as WorkspaceOrigin, id: urlSpace[2] } : selection
  const localDefault = workspaces.find(w => w.origin === 'local' && w.kind === 'PERSONAL')
  const current = workspaces.find(w => w.id === requested.id && w.origin === requested.origin)
    ?? (requested.origin === 'local' && requested.id === 'local' ? localDefault : undefined)
    ?? { ...fallback, id: requested.id, origin: requested.origin, name: requested.origin === 'local' ? '개인 공간' : requested.id === 'public' ? '공용' : '워크스페이스 확인 중', myRole: 'VIEWER', canManage: false }
  const scopeKey = `${current.origin}:${current.origin === 'server' ? `${serverUrl}:${login ?? auth.me?.username ?? ''}` : 'pc'}:${current.id}`
  useEffect(() => {
    if (desktop && connection.data?.connected === false && selection.origin === 'server') {
      const next = { id: localSpaces.data?.[0]?.id ?? 'local', origin: 'local' as const }
      navigate(`/flows?space=${encodeURIComponent(`local:${next.id}`)}`, { replace: true })
      return
    }
    const params = new URLSearchParams(location.search)
    const fromUrl = params.get('space')?.match(/^(local|server):(.+)$/)
    if (requested.origin === 'local' && requested.id === 'local' && localDefault) {
      setSelection({ origin: 'local', id: localDefault.id })
      params.set('space', `local:${localDefault.id}`)
      navigate(workspaceLocation(location.pathname, params.toString(), location.hash), { replace: true, state: location.state })
      return
    }
    if (fromUrl && (fromUrl[1] !== selection.origin || fromUrl[2] !== selection.id)) {
      const committed = { origin: fromUrl[1] as WorkspaceOrigin, id: fromUrl[2] }
      setSelection(committed)
      try { localStorage.setItem(storageKey, JSON.stringify(committed)) } catch { /* private mode */ }
      return
    }
    if (!fromUrl) {
      params.set('space', `${selection.origin}:${selection.id}`)
    }
    if (!fromUrl || workspaceLocation(location.pathname, '').pathname !== location.pathname) {
      navigate(workspaceLocation(location.pathname, params.toString(), location.hash), { replace: true, state: location.state })
    }
  }, [desktop, connection.data?.connected, localSpaces.data, localDefault, requested.origin, requested.id, location.pathname, location.search, location.hash, location.state, navigate, selection.origin, selection.id])
  // 로그인·서버 주소 변경은 내 PC 자원의 API 객체와 환경 초안을 바꾸지 않는다.
  const currentTransport = desktop && current.origin === 'server' ? serverApi : localApi
  const currentResourceBase = current.origin === 'server' ? serverUrl : undefined
  const currentLogin = desktop && current.origin === 'server' ? login : null
  const api = useMemo(() => createApi(currentTransport, current.id, currentResourceBase, currentLogin), [currentTransport, current.id, currentResourceBase, currentLogin])
  // Each workspace owns a cache. Old async responses and invalidations cannot reach a newly selected workspace.
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, queryKeyHashFn: key => hashKey([scopeKey, ...key]) } } }), [scopeKey])
  const select = (id: string, origin?: WorkspaceOrigin) => {
    const target = workspaces.find(w => w.id === id && (!origin || w.origin === origin))
    const next = { id, origin: target?.origin ?? origin ?? current.origin }
    const section = location.pathname.split('/')[1]
    const destination = ['flows', 'mocks', 'protocols', 'plugins', 'executions', 'resources'].includes(section) ? section : 'flows'
    navigate(`/${destination}?space=${encodeURIComponent(`${next.origin}:${next.id}`)}`)
  }
  const agentApi = useCallback((origin: WorkspaceOrigin, workspaceId?: string) => createApi(desktop && origin === 'server' ? serverApi : localApi,
      origin === 'local' ? (workspaces.find(w => w.origin === 'local')?.id ?? 'local') : (workspaceId ?? (current.origin === 'server' ? current.id : 'public')),
      origin === 'server' ? serverUrl : undefined, desktop && origin === 'server' ? login : null), [desktop, workspaces, current.origin, current.id, serverUrl, login])
  const value: Scope = { current, workspaces, api, scopeKey, remoteKey, connected, login, remoteError: remoteSpaces.isError, loading: current.origin === 'local' ? localSpaces.isLoading : remoteSpaces.isLoading, remoteLoading: remoteSpaces.isLoading,
    select, refresh: () => { if (desktop) void localSpaces.refetch(); if (connected) void remoteSpaces.refetch() }, agentApi,
  }
  return <WorkspaceContext.Provider value={value}><QueryClientProvider key={scopeKey} client={queryClient}>{children}</QueryClientProvider></WorkspaceContext.Provider>
}

export function useWorkspace() { const scope = useContext(WorkspaceContext); if (!scope) throw new Error('워크스페이스가 준비되지 않았습니다.'); return scope }
export function useApi() { return useWorkspace().api }
