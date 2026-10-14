import { http } from '../api/client'

/** 백엔드 /auth/config — 인증 모드 발견. mode: "github"(GitHub 로그인) | "none"(dev, 로그인 없음). mcpUrl: 중앙 서버 MCP 주소(개인 호스트는 null). */
export interface AuthConfig {
  enabled: boolean
  mode: string
  mcpUrl?: string | null
  mcpPort?: number | null
  runtime?: { kind: 'local' | 'server'; name: string; deviceId?: string | null }
}

/** 백엔드 /auth/me — dev 모드는 전권 가짜 사용자(dev/default), github 게스트 모드(무인증)는 "guest" 전권 사용자. */
export interface Me {
  username: string
  tenant: string
  roles: string[]
}

export interface DeviceStart { sessionId: string; userCode: string; verificationUri: string; intervalSec: number; expiresIn: number }
export interface DevicePoll { status: 'pending' | 'ready' | 'error'; token?: string; login?: string; error?: string }

const TOKEN_KEY = 'fl:token' // 앱 JWT(GitHub 로그인 후 발급) — localStorage 보관

export function getAccessToken(): string | null { return typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null }
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

export const authApi = {
  config: () => http.get<AuthConfig>('/auth/config').then((r) => r.data),
  me: () => http.get<Me>('/auth/me', { timeout: 10_000 }).then((r) => r.data),
  deviceStart: () => http.post<DeviceStart>('/auth/github/device/start', {}).then((r) => r.data),
  devicePoll: (session: string) => http.get<DevicePoll>('/auth/github/device/poll', { params: { session } }).then((r) => r.data),
}

let interceptorsAttached = false
let authCheck: { token: string; request: Promise<Me> } | null = null

/**
 * axios 인터셉터 — Bearer(앱 JWT) 부착 + 현재 토큰의 인증 실패가 확인됐을 때만 폐기 후 재부트.
 * GitHub 로그인 모드에서만 부착(dev 모드는 무회귀).
 */
export function attachAuthInterceptors() {
  if (interceptorsAttached) return
  interceptorsAttached = true
  for (const inst of [http]) {
    inst.interceptors.request.use((config) => {
      const t = getAccessToken()
      if (t) config.headers.Authorization = `Bearer ${t}`
      return config
    })
    inst.interceptors.response.use(
      (res) => res,
      async (error) => {
        const status = error?.response?.status
        // /auth/** 자체(로그인 폴링 등)의 401 은 무시 — 무한 리로드 방지
        const url: string = error?.config?.url ?? ''
        if (status === 401 && !url.includes('/auth/')) {
          const token = getAccessToken()
          // 기능별 인증 오류와 이전 로그인 요청의 지연 응답으로 현재 로그인을 지우지 않는다.
          if (token && error?.config?.headers?.Authorization === `Bearer ${token}`) {
            if (authCheck?.token !== token) authCheck = { token, request: authApi.me() }
            const check = authCheck
            try { await check.request }
            catch (checkError) {
              if ((checkError as { response?: { status?: number } })?.response?.status === 401 && getAccessToken() === token) {
                setToken(null)
                if (typeof window !== 'undefined') window.location.reload()
              }
            } finally { if (authCheck === check) authCheck = null }
          }
        }
        throw error
      },
    )
  }
}
