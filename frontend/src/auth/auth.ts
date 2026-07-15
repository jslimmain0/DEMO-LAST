import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts'
import { http, uploadHttp } from '../api/client'

/** 백엔드 /auth/config 응답 — 인증 모드 발견(env 불필요). */
export interface AuthConfig {
  enabled: boolean
  issuer: string | null
  clientId: string
}

/** 백엔드 /auth/me 응답 — dev 모드에선 전권 가짜 사용자(dev/default). */
export interface Me {
  username: string
  tenant: string
  roles: string[]
}

export const authApi = {
  config: () => http.get<AuthConfig>('/auth/config').then((r) => r.data),
  me: () => http.get<Me>('/auth/me').then((r) => r.data),
}

let userManager: UserManager | null = null
let accessToken: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

function applyUser(user: User | null) {
  accessToken = user && !user.expired ? user.access_token : null
}

/** OIDC UserManager 초기화(enabled 모드에서만). redirect URI 는 현재 오리진 기준 — dev(5173)/jar(18080) 겸용. */
export function initUserManager(cfg: AuthConfig): UserManager {
  if (userManager) return userManager
  const um = new UserManager({
    authority: cfg.issuer ?? '',
    client_id: cfg.clientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'openid profile',
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
  })
  um.events.addUserLoaded((u) => applyUser(u))
  um.events.addUserUnloaded(() => applyUser(null))
  um.events.addAccessTokenExpired(() => applyUser(null))
  userManager = um
  return um
}

/** 현재 위치를 기억하고 IdP 로그인으로 리다이렉트. */
export function signinRedirect(): Promise<void> {
  const returnTo = window.location.pathname + window.location.search
  return userManager!.signinRedirect({ state: { returnTo } })
}

/** /auth/callback 에서 코드 교환 — 돌아갈 경로를 반환. */
export async function completeSignin(): Promise<string> {
  const user = await userManager!.signinRedirectCallback()
  applyUser(user)
  const st = user.state as { returnTo?: string } | undefined
  return st?.returnTo && st.returnTo !== '/auth/callback' ? st.returnTo : '/'
}

/** 저장된 세션 복구(만료면 null). */
export async function loadStoredUser(): Promise<User | null> {
  const u = await userManager!.getUser()
  if (u && !u.expired) {
    applyUser(u)
    return u
  }
  return null
}

/** refresh token 으로 조용히 갱신 — 성공 시 새 토큰, 실패 시 null. */
export async function trySilentRenew(): Promise<string | null> {
  if (!userManager) return null
  try {
    const u = await userManager.signinSilent()
    applyUser(u)
    return u && !u.expired ? u.access_token : null
  } catch {
    return null
  }
}

export function signoutRedirect(): Promise<void> {
  accessToken = null
  return userManager!.signoutRedirect()
}

let interceptorsAttached = false

/**
 * axios 인터셉터 — Bearer 부착 + 401 시 silent 갱신 1회 재시도, 실패면 로그인 리다이렉트.
 * dev 모드(enabled=false)에선 아예 부착하지 않는다(현행 무회귀).
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
      async (error) => {
        const status = error?.response?.status
        const cfg = error?.config
        if (status === 401 && cfg && !cfg._flRetried) {
          const renewed = await trySilentRenew()
          if (renewed) {
            cfg._flRetried = true
            cfg.headers = { ...cfg.headers, Authorization: `Bearer ${renewed}` }
            return inst.request(cfg)
          }
          // 갱신 실패 — 세션 만료로 보고 재로그인 (진행 중 작업은 브라우저 leave 경고가 지킨다)
          void signinRedirect()
        }
        throw error
      },
    )
  }
}
