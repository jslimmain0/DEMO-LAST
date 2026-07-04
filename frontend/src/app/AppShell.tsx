import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getTheme, toggleTheme, type Theme } from '../design/theme'

const NAV = [
  { to: '/flows', label: '대시보드', icon: '▤' },
  { to: '/mocks', label: 'Mock 서버', icon: '◈' },
  { to: '/executions', label: '실행 이력', icon: '◴' },
]

/** 앱 전역 셸 — AI Studio 식 좌측 세로 사이드바 네비 + 우측 콘텐츠.
 *  sidebarExtra: 페이지가 사이드바에 덧붙이는 컨텍스트 UI(예: 대시보드의 폴더 목록). */
export function AppShellTier1({ children, sidebarExtra }: { children: ReactNode; sidebarExtra?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getTheme())
  const loc = useLocation()

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

        <div style={sectionLabel}>워크스페이스</div>
        <nav style={{ display: 'grid', gap: 2 }}>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} style={navItem(n.to)}>
              <span aria-hidden style={{ width: 16, textAlign: 'center', fontSize: 14 }}>{n.icon}</span>
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>

        {sidebarExtra && <div style={{ marginTop: 8, overflowY: 'auto', flex: '0 1 auto' }}>{sidebarExtra}</div>}

        <button
          onClick={() => setTheme(toggleTheme())}
          aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          style={themeBtn}
        >
          <span aria-hidden style={{ fontSize: 15 }}>{theme === 'dark' ? '☀' : '🌙'}</span>
          <span>{theme === 'dark' ? '라이트 모드' : '다크 모드'}</span>
        </button>
      </aside>

      <main id="main" style={{ flex: 1, minWidth: 0 }}>{children}</main>
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
