import type { CSSProperties } from 'react'
import { useAuth } from '../auth/AuthContext'

/**
 * 게스트용 AI 게이트 — github 모드에서 로그인 없이 AI 패널을 열면 채팅 대신 이 카드가 뜬다.
 * 로그인하면 서버가 GitHub 토큰을 Copilot 연결로도 재사용(한 번 로그인 = 앱 + AI).
 * variant: 'editor'=에디터 우측 도킹 패널, 'overlay'=Mock 편집기 우측 고정 오버레이(MockAssistantPanel 과 동일 셸).
 */
export function AssistantLoginGate({ width, onClose, variant = 'editor', reason = 'guest' }: {
  width?: number
  onClose: () => void
  variant?: 'editor' | 'overlay'
  /** guest=로그인 필요 · pending=가입 승인 대기(로그인은 했지만 관리자 승인 전 — Copilot 연결 헛수고 방지) */
  reason?: 'guest' | 'pending'
}) {
  const { requestLogin } = useAuth()
  const shell: CSSProperties = variant === 'overlay'
    ? { position: 'fixed', top: 0, right: 0, height: '100vh', width: 340, zIndex: 60, boxShadow: 'var(--fl-shadow-lg)' }
    : { width: width ?? 360, flexShrink: 0 }
  return (
    <aside style={{ ...shell, borderLeft: '1px solid var(--fl-border)', background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden>✨</span>
        <b style={{ flex: 1, fontSize: 13.5 }}>AI 어시스턴트</b>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
        <span aria-hidden style={{ fontSize: 30 }}>{reason === 'pending' ? '⏳' : '🔒'}</span>
        <b style={{ fontSize: 14 }}>{reason === 'pending' ? '가입 승인 대기 중' : 'GitHub 로그인이 필요합니다'}</b>
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: 'var(--fl-text-muted)' }}>
          {reason === 'pending'
            ? '관리자가 가입 신청을 승인하면 AI 어시스턴트를 쓸 수 있습니다. 나머지 기능(공용 워크스페이스)은 지금도 쓸 수 있어요.'
            : 'AI 어시스턴트는 GitHub Copilot 을 사용합니다. 로그인하면 Copilot 이 자동으로 연결되고, 나머지 기능은 로그인 없이도 계속 쓸 수 있습니다.'}
        </p>
        {reason === 'guest' && (
          <button onClick={requestLogin} style={loginBtn}>
            <span aria-hidden style={{ fontSize: 15 }}>🐙</span> GitHub 로 로그인
          </button>
        )}
      </div>
    </aside>
  )
}

const xBtn: CSSProperties = { width: 26, height: 26, borderRadius: 7, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const loginBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--fl-primary)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }
