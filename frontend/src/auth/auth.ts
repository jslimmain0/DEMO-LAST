import { http, uploadHttp } from '../api/client'

/** 백엔드 /auth/config — 인증 모드 발견. mode: "github"(GitHub 로그인) | "none"(dev, 로그인 없음). */
export interface AuthConfig {
  enabled: boolean
  mode: string
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
let accessToken: string | null = typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null

export function getAccessToken(): string | null { return accessToken }
export function setToken(t: string | null) {
  accessToken = t
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

export const authApi = {
  config: () => http.get<AuthConfig>('/auth/config').then((r) => r.data),
  me: () => http.get<Me>('/auth/me').then((r) => r.data),
  deviceStart: () => http.post<DeviceStart>('/auth/github/device/start', {}).then((r) => r.data),
  devicePoll: (session: string) => http.get<DevicePoll>('/auth/github/device/poll', { params: { session } }).then((r) => r.data),
}

let interceptorsAttached = false

/**
 * axios 인터셉터 — Bearer(앱 JWT) 부착 + 401 시 토큰이 있었을 때만 폐기 후 재부트(게스트 무토큰 401 은 무시).
 * GitHub 로그인 모드에서만 부착(dev 모드는 무회귀).
 */
export function attachAuthInterceptors() {
  if (interceptorsAttached) return
  interceptorsAttached = true
  for (const inst of [http, uploadHttp]) {
    inst.interceptors.request.use((config) => {
      const t = getAccessToken()
      if (t) config.headers.Authorization = `Bearer ${t}`
      return config
    })
    inst.interceptors.response.use(
      (res) => res,
      (error) => {
        const status = error?.response?.status
        // /auth/** 자체(로그인 폴링 등)의 401 은 무시 — 무한 리로드 방지
        const url: string = error?.config?.url ?? ''
        if (status === 401 && !url.includes('/auth/')) {
          // 게스트(무토큰)의 401 은 정상(AI 게이트) — 리로드 루프를 만들지 않는다. 토큰이 있었을 때만 폐기·재부트.
          if (getAccessToken()) {
            setToken(null)
            if (typeof window !== 'undefined') window.location.reload() // 세션 만료 → 게스트/로그인 재부트
          }
        }
        throw error
      },
    )
  }
}
