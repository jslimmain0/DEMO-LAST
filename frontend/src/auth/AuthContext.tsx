import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import {
  attachAuthInterceptors,
  authApi,
  initUserManager,
  loadStoredUser,
  signinRedirect,
  signoutRedirect,
  type Me,
} from './auth'

interface AuthState {
  /** 부트스트랩(config 조회·세션 복구·/me) 완료 여부 — false 동안은 화면을 그리지 않는다. */
  ready: boolean
  /** OIDC 인증 모드 여부(백엔드 issuer-uri 설정 유무). */
  enabled: boolean
  me: Me | null
  logout: () => void
}

const AuthContext = createContext<AuthState>({ ready: false, enabled: false, me: null, logout: () => {} })

/** StrictMode 이중 이펙트/중복 마운트에도 부트스트랩은 1회만. */
let bootPromise: Promise<{ enabled: boolean; me: Me | null; redirecting: boolean }> | null = null

async function boot(): Promise<{ enabled: boolean; me: Me | null; redirecting: boolean }> {
  const cfg = await authApi.config()
  if (!cfg.enabled) {
    // dev 모드 — 로그인 없음. /me 는 전권 가짜 사용자(게이팅 단일 경로).
    const me = await authApi.me().catch(() => null)
    return { enabled: false, me, redirecting: false }
  }
  initUserManager(cfg)
  attachAuthInterceptors()
  const user = await loadStoredUser()
  if (!user) {
    await signinRedirect()
    return { enabled: true, me: null, redirecting: true }
  }
  const me = await authApi.me().catch(() => null)
  return { enabled: true, me, redirecting: false }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; enabled: boolean; me: Me | null }>({
    ready: false,
    enabled: false,
    me: null,
  })

  useEffect(() => {
    // 콜백 라우트는 AuthCallback 이 스스로 처리 — 여기서 로그인 리다이렉트를 걸면 코드 교환이 유실된다
    if (window.location.pathname === '/auth/callback') {
      setState({ ready: true, enabled: true, me: null })
      return
    }
    if (!bootPromise) bootPromise = boot()
    bootPromise.then((r) => {
      if (!r.redirecting) setState({ ready: true, enabled: r.enabled, me: r.me })
    })
  }, [])

  const logout = () => {
    if (state.enabled) void signoutRedirect()
  }

  if (!state.ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--fl-text-muted)' }}>
        로그인 확인 중…
      </div>
    )
  }
  return <AuthContext.Provider value={{ ...state, logout }}>{children}</AuthContext.Provider>
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
