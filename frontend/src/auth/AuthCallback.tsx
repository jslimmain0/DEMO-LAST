import { useEffect, useRef, useState } from 'react'
import { authApi, completeSignin, initUserManager } from './auth'

/**
 * OIDC 코드 교환 라우트(/auth/callback).
 * StrictMode 가 이펙트를 두 번 돌려도 교환은 1회만(ref 가드) — 두 번째 교환은 코드 재사용 에러가 난다.
 * 교환 후에는 SPA 라우터가 아닌 전체 리로드로 복귀 — AuthProvider 부트스트랩이 새 세션으로 다시 돈다.
 */
export function AuthCallback() {
  const ran = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    ;(async () => {
      try {
        const cfg = await authApi.config()
        if (!cfg.enabled) {
          window.location.replace('/')
          return
        }
        initUserManager(cfg)
        const returnTo = await completeSignin()
        window.location.replace(returnTo)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh', color: 'var(--fl-text-muted)' }}>
      {error ? (
        <div>
          <div style={{ color: 'var(--fl-fail)', marginBottom: 8 }}>로그인 처리 실패: {error}</div>
          <a href="/">처음으로</a>
        </div>
      ) : (
        '로그인 처리 중…'
      )}
    </div>
  )
}
