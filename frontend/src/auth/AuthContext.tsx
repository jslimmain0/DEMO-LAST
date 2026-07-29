import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { attachAuthInterceptors, authApi, getAccessToken, setToken, type Me } from './auth'
import { GitHubLogin } from './GitHubLogin'

interface AuthState {
  /** 부트스트랩 완료 여부 — false 동안은 화면을 그리지 않는다. */
  ready: boolean
  /** 인증 모드 여부(github|oidc). false=dev(로그인 없음). */
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
  /** github 모드 + 토큰 없음 — 로그인 화면 대신 게스트 진입. */
  guest?: boolean
  /** OIDC 등 SPA 셀프 로그인이 없는 인증 모드인데 유효 토큰이 없음 — 로그인 화면 대신 안내. */
  blockedOidc?: boolean
}

/** github 게스트 모드에서 /me 실패 시 로컬 폴백 — 백엔드 guest 응답과 동일 구조. */
const GUEST_ME: Me = { username: 'guest', tenant: 'default', roles: ['admin', 'editor', 'platform-admin'] }

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
  // 인증 모드(github | oidc)
  attachAuthInterceptors()
  if (getAccessToken()) {
    try {
      const me = await authApi.me()
      return { mode: cfg.mode, me }
    } catch (e) {
      const status = errStatus(e)
      if (status === 401 || status === 403) {
        setToken(null) // 무효/만료 토큰만 폐기 → 아래 게스트/안내 경로로
      } else {
        // 일시 오류(5xx/네트워크)엔 유효 토큰을 버리지 않는다 — me 없이 진행(다음 새로고침에 재조회).
        return { mode: cfg.mode, me: null }
      }
    }
  }
  if (cfg.mode === 'github') {
    // 게스트 진입 — github 모드는 앱 개방(AI 만 로그인 게이트). /me 는 permitAll(guest 응답).
    const me = await authApi.me().catch(() => GUEST_ME)
    return { mode: 'github', me, guest: true }
  }
  // oidc — SPA 셀프 로그인 흐름이 없다(외부 IdP 토큰 필요). 조용히 깨지지 않게 안내 화면.
  return { mode: 'oidc', me: null, blockedOidc: true }
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
  if (b.blockedOidc) {
    return (
      <div style={centered}>
        <div style={{ maxWidth: 420, textAlign: 'center', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 800, fontSize: 20, marginBottom: 8 }}>외부 IdP 인증 필요</div>
          이 인스턴스는 OIDC(외부 IdP) 토큰 인증 모드입니다. 화면 자체 로그인은 제공되지 않습니다 —
          유효한 액세스 토큰으로 API 를 호출하거나, GitHub 로그인 모드로 전환하세요.
        </div>
      </div>
    )
  }
  return (
    <AuthContext.Provider
      value={{
        ready: true,
        enabled: b.mode !== 'none',
        isGuest: b.guest === true,
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
