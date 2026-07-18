import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { attachAuthInterceptors, authApi, getAccessToken, setToken, type Me } from './auth'
import { GitHubLogin } from './GitHubLogin'

interface AuthState {
  /** 부트스트랩 완료 여부 — false 동안은 화면을 그리지 않는다. */
  ready: boolean
  /** 인증 모드 여부(로그인 필요). false=dev(로그인 없음). */
  enabled: boolean
  me: Me | null
  logout: () => void
}

const AuthContext = createContext<AuthState>({ ready: false, enabled: false, me: null, logout: () => {} })

interface Boot {
  mode: string
  me: Me | null
  needsLogin: boolean
  /** OIDC 등 SPA 셀프 로그인이 없는 인증 모드인데 유효 토큰이 없음 — 로그인 화면 대신 안내. */
  blockedOidc?: boolean
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
    return { mode: 'none', me, needsLogin: false }
  }
  // 인증 필수 모드(github | oidc)
  attachAuthInterceptors()
  if (getAccessToken()) {
    try {
      const me = await authApi.me()
      return { mode: cfg.mode, me, needsLogin: false }
    } catch (e) {
      const status = errStatus(e)
      if (status === 401 || status === 403) {
        setToken(null) // 무효/만료 토큰만 폐기 → 재로그인
      } else {
        // 일시 오류(5xx/네트워크/타임아웃)엔 유효 토큰을 버리지 않는다 — 로그아웃 없이 진행(me 는 다음 새로고침에 재조회).
        return { mode: cfg.mode, me: null, needsLogin: false }
      }
    }
  }
  // 토큰 없음(또는 방금 폐기)
  if (cfg.mode === 'github') return { mode: 'github', me: null, needsLogin: true }
  // oidc — SPA 셀프 로그인 흐름이 없다(외부 IdP 토큰 필요). 조용히 깨지지 않게 안내 화면.
  return { mode: 'oidc', me: null, needsLogin: false, blockedOidc: true }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ ready: boolean; boot: Boot | null }>({ ready: false, boot: null })

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
  if (b.needsLogin) {
    // 로그인 성공 → 리로드로 재부트(토큰으로 /me 조회 → 인증 상태)
    return <GitHubLogin onSuccess={() => window.location.reload()} />
  }
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
    <AuthContext.Provider value={{ ready: true, enabled: b.mode !== 'none', me: b.me, logout }}>{children}</AuthContext.Provider>
  )
}

const centered = { display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--fl-text-muted)', padding: 24 } as const

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
