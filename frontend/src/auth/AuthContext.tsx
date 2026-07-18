import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { attachAuthInterceptors, authApi, getAccessToken, setToken, type Me } from './auth'
import { GitHubLogin } from './GitHubLogin'

interface AuthState {
  /** 부트스트랩 완료 여부 — false 동안은 화면을 그리지 않는다. */
  ready: boolean
  /** 인증 모드 여부(GitHub 로그인 활성). false=dev(로그인 없음). */
  enabled: boolean
  me: Me | null
  logout: () => void
}

const AuthContext = createContext<AuthState>({ ready: false, enabled: false, me: null, logout: () => {} })

/** StrictMode 이중 이펙트에도 부트스트랩은 1회만. */
let bootPromise: Promise<{ enabled: boolean; me: Me | null; needsLogin: boolean }> | null = null

async function boot(): Promise<{ enabled: boolean; me: Me | null; needsLogin: boolean }> {
  const cfg = await authApi.config()
  if (cfg.mode !== 'github') {
    // dev 모드 — 로그인 없음. /me 는 전권 가짜 사용자(게이팅 단일 경로).
    const me = await authApi.me().catch(() => null)
    return { enabled: false, me, needsLogin: false }
  }
  // GitHub 로그인 모드
  attachAuthInterceptors()
  if (getAccessToken()) {
    const me = await authApi.me().catch(() => null)
    if (me) return { enabled: true, me, needsLogin: false }
    setToken(null) // 만료/무효 토큰
  }
  return { enabled: true, me: null, needsLogin: true }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; enabled: boolean; me: Me | null; needsLogin: boolean }>({
    ready: false, enabled: false, me: null, needsLogin: false,
  })

  useEffect(() => {
    if (!bootPromise) bootPromise = boot()
    bootPromise.then((r) => setState({ ready: true, enabled: r.enabled, me: r.me, needsLogin: r.needsLogin }))
  }, [])

  const logout = () => {
    setToken(null)
    if (typeof window !== 'undefined') window.location.reload()
  }

  if (!state.ready) {
    return <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--fl-text-muted)' }}>로그인 확인 중…</div>
  }
  if (state.needsLogin) {
    // 로그인 성공 → 리로드로 재부트(토큰으로 /me 조회 → 인증 상태)
    return <GitHubLogin onSuccess={() => window.location.reload()} />
  }
  return <AuthContext.Provider value={{ ready: state.ready, enabled: state.enabled, me: state.me, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

/** 역할 기반 UI 게이팅 — dev 모드는 /me 가 전권이라 모두 true. */
export function usePermissions() {
  const { me } = useAuth()
  const roles = me?.roles ?? []
  const canEdit = roles.includes('editor') || roles.includes('admin')
  return {
    canEdit,
    canAdmin: roles.includes('admin'),
    canPlatformAdmin: roles.includes('platform-admin'),
    isViewer: !canEdit,
  }
}
