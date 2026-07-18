import type { CSSProperties } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authApi, setToken, type DeviceStart } from './auth'

/**
 * GitHub 로그인 화면 — Copilot 과 동일한 디바이스 플로우. 코드를 표시하고 github.com/login/device 를 열어
 * 사용자가 입력하면 백엔드가 신원 확인 후 앱 JWT 를 발급한다. 폴링으로 완료를 감지한다.
 */
export function GitHubLogin({ onSuccess }: { onSuccess: () => void }) {
  const [device, setDevice] = useState<DeviceStart | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }

  const start = useCallback(async () => {
    setError(null); setBusy(true); stopPoll()
    try {
      const d = await authApi.deviceStart()
      setDevice(d)
      try { await navigator.clipboard?.writeText(d.userCode) } catch { /* ignore */ }
      window.open(d.verificationUri, '_blank', 'noopener')
      pollRef.current = setInterval(async () => {
        try {
          const r = await authApi.devicePoll(d.sessionId)
          if (r.status === 'ready' && r.token) { stopPoll(); setToken(r.token); onSuccess() }
          else if (r.status === 'error') { stopPoll(); setError(r.error || '로그인 실패'); setDevice(null) }
        } catch { /* keep polling */ }
      }, Math.max(2, d.intervalSec) * 1000)
    } catch (e) {
      setError((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'GitHub 로그인 시작 실패')
    } finally { setBusy(false) }
  }, [onSuccess])

  useEffect(() => () => stopPoll(), [])

  return (
    <div style={overlay}>
      <div style={card}>
        <div style={{ fontFamily: 'var(--fl-font-head, sans-serif)', fontSize: 26, fontWeight: 800, letterSpacing: '-.02em', marginBottom: 4 }}>FlowLink</div>
        <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginBottom: 22 }}>GitHub 계정으로 로그인</div>

        {!device && (
          <>
            <button onClick={start} disabled={busy} style={ghBtn}>
              <span aria-hidden style={{ fontSize: 16 }}>🐙</span> {busy ? '준비 중…' : 'GitHub 로 로그인'}
            </button>
            {error && <p style={{ color: 'var(--fl-fail)', fontSize: 12.5, marginTop: 12 }}>{error}</p>}
          </>
        )}

        {device && (
          <div style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 10px' }}>열린 GitHub 페이지에 아래 코드를 입력하세요(복사됨):</p>
            <code style={codeBox}>{device.userCode}</code>
            <p style={{ margin: '12px 0 0', color: 'var(--fl-text-muted)' }}>
              인증하면 자동으로 로그인됩니다…{' '}
              <a href={device.verificationUri} target="_blank" rel="noreferrer" style={{ color: 'var(--fl-primary)' }}>페이지 다시 열기 ↗</a>
            </p>
            <button onClick={start} style={{ ...ghBtn, marginTop: 16, background: 'transparent', color: 'var(--fl-text-muted)', border: '1px solid var(--fl-border)' }}>다시 시작</button>
          </div>
        )}
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--fl-bg, #0f1115)' }
const card: CSSProperties = { width: 360, maxWidth: '90vw', padding: 32, borderRadius: 14, background: 'var(--fl-surface, #1a1d27)', border: '1px solid var(--fl-border, #2a2e3a)', boxShadow: '0 20px 60px rgba(0,0,0,.4)', textAlign: 'center' }
const ghBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px', border: 'none', borderRadius: 10, background: 'var(--fl-primary, #6155f5)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }
const codeBox: CSSProperties = { display: 'inline-block', fontSize: 24, fontWeight: 700, letterSpacing: 3, fontFamily: 'var(--fl-font-mono, monospace)', background: 'var(--fl-surface-2, #22262f)', padding: '8px 16px', borderRadius: 8 }
