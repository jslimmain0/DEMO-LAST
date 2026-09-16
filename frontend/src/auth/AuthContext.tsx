import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { attachAuthInterceptors, authApi, getAccessToken, setToken, type Me } from './auth'
import { GitHubLogin } from './GitHubLogin'

interface AuthState {
  /** 부트스트랩 완료 여부 — false 동안은 화면을 그리지 않는다. */
  ready: boolean
  /** 인증 모드 여부(github). false=dev(로그인 없음). */
  enabled: boolean
  /** github 모드에서 로그인하지 않은 게스트 — 앱은 전부 쓰되 AI 만 로그인 필요. */
  isGuest: boolean
  me: Me | null
  logout: () => void
  /** 게스트가 AI 등을 위해 로그인할 때 — GitHub 디바이스 로그인 모달을 연다. */
  requestLogin: () => void
}

const AuthContext = createContext<AuthState>({
  ready: false, enabled: false, isGuest: false, me: null, logout: () => {}, requestLogin: () => {},
})

interface Boot {
  mode: string
  me: Me | null
  /** github 모드 + 유효 토큰 없음 — 로그인 화면을 강제로 띄운다(게스트 진입 없음). */
  needsLogin?: boolean
}

/** StrictMode 이중 이펙트에도 부트스트랩은 1회만. */
let bootPromise: Promise<Boot> | null = null

function errStatus(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status
}

async function boot(): Promise<Boot> {
  const cfg = await authApi.config()
  if (cfg.mode === 'none') {
    // dev 모드 — 로그인 없음. /me 는 전권 가짜 사용자(게이팅 단일 경로).
    const me = await authApi.me().catch(() => null)
    return { mode: 'none', me }
  }
  // 인증 모드(github) — 브라우저는 무조건 로그인(게스트 모드는 MCP 에이전트 전용, UI 는 로그인 강제).
  attachAuthInterceptors()
  if (getAccessToken()) {
    try {
      const me = await authApi.me()
      return { mode: cfg.mode, me }
    } catch (e) {
      const status = errStatus(e)
      if (status === 401 || status === 403) {
        setToken(null) // 무효/만료 토큰만 폐기 → 로그인 화면으로
      } else {
        // 일시 오류(5xx/네트워크)엔 유효 토큰을 버리지 않는다 — me 없이 진행(다음 새로고침에 재조회).
        return { mode: cfg.mode, me: null }
      }
    }
  }
  // 토큰 없음 → 로그인 화면 강제.
  return { mode: cfg.mode, me: null, needsLogin: true }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; boot: Boot | null }>({ ready: false, boot: null })
  const [loginOpen, setLoginOpen] = useState(false)

  useEffect(() => {
    if (!bootPromise) bootPromise = boot()
    bootPromise.then((b) => setState({ ready: true, boot: b }))
  }, [])

  const logout = () => {
    setToken(null)
    if (typeof window !== 'undefined') window.location.reload()
  }

  if (!state.ready || !state.boot) {
    return <div style={centered}>로그인 확인 중…</div>
  }
  const b = state.boot
  // github 모드 + 무토큰 → 로그인 화면만(취소 불가). 앱은 로그인 후에만 보인다.
  if (b.needsLogin) {
    return <GitHubLogin onSuccess={() => window.location.reload()} />
  }
  return (
    <AuthContext.Provider
      value={{
        ready: true,
        enabled: b.mode !== 'none',
        isGuest: false, // 게스트 UI 없음 — github 모드는 항상 로그인 상태
        me: b.me,
        logout,
        requestLogin: () => setLoginOpen(true),
      }}
    >
      {children}
      {loginOpen && <GitHubLogin onSuccess={() => window.location.reload()} onCancel={() => setLoginOpen(false)} />}
    </AuthContext.Provider>
  )
}

const centered = { display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--fl-text-muted)', padding: 24 } as const

export function useAuth(): AuthState {
  return useContext(AuthContext)
}

/** 역할 기반 UI 게이팅 — dev/게스트 모드는 /me 가 전권이라 모두 true. */
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
