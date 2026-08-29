import { useQuery } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { adminApi } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { SettingsDialog } from '../components/SettingsDialog'
import { getTheme, toggleTheme, type Theme } from '../design/theme'

const NAV = [
  { to: '/flows', label: '대시보드', icon: '▤' },
  { to: '/mocks', label: 'Mock 서버', icon: '◈' },
  { to: '/executions', label: '실행 이력', icon: '◴' },
]
// 관리 콘솔 — 관리자에게만 노출(백엔드 /admin/* 도 403 으로 이중 방어)
const NAV_ADMIN = { to: '/admin', label: '관리', icon: '🛡' }

/** 앱 전역 셸 — AI Studio 식 좌측 세로 사이드바 네비 + 우측 콘텐츠.
 *  sidebarExtra: 페이지가 사이드바에 덧붙이는 컨텍스트 UI(예: 대시보드의 폴더 목록). */
export function AppShellTier1({ children, sidebarExtra }: { children: ReactNode; sidebarExtra?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getTheme())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const loc = useLocation()
  const { enabled: authEnabled, me, logout, isGuest, requestLogin } = useAuth()
  // 관리자 여부(캐시 5분) — 관리 네비 노출 게이트
  const adminMe = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 300_000 })
  const nav = adminMe.data?.admin ? [...NAV, NAV_ADMIN] : NAV

  const navItem = (to: string): CSSProperties => {
    const active = loc.pathname.startsWith(to)
    return {
      display: 'flex',
      alignItems: 'center',
      gap: 11,
      padding: '9px 12px',
      borderRadius: 'var(--fl-radius-sm)',
      textDecoration: 'none',
      fontSize: 13.5,
      fontWeight: active ? 600 : 500,
      color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)',
      background: active ? 'var(--fl-surface-2)' : 'transparent',
      borderLeft: `2px solid ${active ? 'var(--fl-primary)' : 'transparent'}`,
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100dvh' }}>
      <a href="#main" style={skipLink}>본문 바로가기</a>

      <aside role="navigation" aria-label="주요" style={sidebar}>
        <Link to="/flows" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--fl-text)', padding: '4px 8px 0' }}>
          <span aria-hidden style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,var(--fl-primary),var(--fl-primary-2))' }} />
          <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17, letterSpacing: '-.01em' }}>FlowLink</span>
        </Link>

        <div style={sectionLabel}>메뉴</div>
        <nav style={{ display: 'grid', gap: 2 }}>
          {nav.map((n) => (
            <Link key={n.to} to={n.to} style={navItem(n.to)}>
              <span aria-hidden style={{ width: 16, textAlign: 'center', fontSize: 14 }}>{n.icon}</span>
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>

        {sidebarExtra && <div style={{ marginTop: 8, overflowY: 'auto', flex: '0 1 auto' }}>{sidebarExtra}</div>}

        {authEnabled && me && (
          <div style={{ ...userChip, marginTop: 'auto' }} title={isGuest ? '게스트 — GitHub 로그인하면 AI 를 쓸 수 있습니다' : `${me.username} · ${me.tenant} · ${me.roles.join(', ')}`}>
            <span aria-hidden style={avatar}>{isGuest ? 'G' : me.username.slice(0, 1).toUpperCase()}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isGuest ? '게스트' : me.username}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isGuest ? 'AI 는 로그인 필요' : `${me.tenant} · ${primaryRole(me.roles)}`}
              </span>
            </span>
            {isGuest ? (
              <button onClick={requestLogin} title="GitHub 로그인" style={loginChipBtn}>로그인</button>
            ) : (
              <button onClick={logout} aria-label="로그아웃" title="로그아웃" style={logoutBtn}>⎋</button>
            )}
          </div>
        )}
        <button onClick={() => setSettingsOpen(true)} aria-label="설정" style={{ ...themeBtn, marginTop: authEnabled && me ? 0 : 'auto' }}>
          <span aria-hidden style={{ fontSize: 15 }}>⚙</span>
          <span>설정</span>
        </button>
        <button
          onClick={() => setTheme(toggleTheme())}
          aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          style={{ ...themeBtn, marginTop: 0 }}
        >
          <span aria-hidden style={{ fontSize: 15 }}>{theme === 'dark' ? '☀' : '🌙'}</span>
          <span>{theme === 'dark' ? '라이트 모드' : '다크 모드'}</span>
        </button>
      </aside>

      <main id="main" style={{ flex: 1, minWidth: 0 }}>{children}</main>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

const sidebar: CSSProperties = {
  width: 216,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '18px 12px',
  borderRight: '1px solid var(--fl-border)',
  background: 'var(--fl-surface)',
  position: 'sticky',
  top: 0,
  height: '100dvh',
}
const sectionLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--fl-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  margin: '20px 8px 8px',
}
/** 대표 역할 하나만 표시(우선순위: admin > editor > viewer). */
function primaryRole(roles: string[]): string {
  if (roles.includes('admin')) return 'admin'
  if (roles.includes('editor')) return 'editor'
  if (roles.includes('viewer')) return 'viewer'
  return roles[0] ?? '역할 없음'
}

const userChip: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderRadius: 'var(--fl-radius-sm)',
  border: '1px solid var(--fl-border)',
  background: 'var(--fl-surface-2)',
}
const avatar: CSSProperties = {
  width: 26,
  height: 26,
  flexShrink: 0,
  borderRadius: '50%',
  display: 'grid',
  placeItems: 'center',
  fontSize: 12,
  fontWeight: 700,
  color: '#fff',
  background: 'linear-gradient(135deg,var(--fl-primary),var(--fl-primary-2))',
}
const logoutBtn: CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--fl-text-muted)',
  cursor: 'pointer',
  fontSize: 14,
  padding: 4,
}
const loginChipBtn: CSSProperties = { flexShrink: 0, border: '1px solid var(--fl-primary)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, padding: '4px 9px', borderRadius: 999 }
const themeBtn: CSSProperties = {
  marginTop: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 11,
  padding: '9px 12px',
  borderRadius: 'var(--fl-radius-sm)',
  border: 'none',
  background: 'transparent',
  color: 'var(--fl-text-muted)',
  cursor: 'pointer',
  fontSize: 13.5,
  fontWeight: 500,
  fontFamily: 'inherit',
  textAlign: 'left',
}
const skipLink: CSSProperties = {
  position: 'absolute',
  left: -9999,
  top: 8,
  background: 'var(--fl-primary)',
  color: '#fff',
  padding: '8px 14px',
  borderRadius: 8,
  zIndex: 100,
}
