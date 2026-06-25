import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { getTheme, toggleTheme, type Theme } from '../design/theme'

export function AppShellTier1({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getTheme())
  const loc = useLocation()
  const navItem = (to: string): CSSProperties => ({
    padding: '7px 12px',
    borderRadius: 'var(--fl-radius-sm)',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 600,
    color: loc.pathname.startsWith(to) ? 'var(--fl-text)' : 'var(--fl-text-muted)',
    background: loc.pathname.startsWith(to) ? 'var(--fl-surface-2)' : 'transparent',
  })

  return (
    <div style={{ minHeight: '100dvh' }}>
      <a href="#main" style={skipLink}>본문 바로가기</a>
      <header role="banner" style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '12px 24px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)', position: 'sticky', top: 0, zIndex: 10 }}>
        <Link to="/flows" style={{ display: 'flex', alignItems: 'center', gap: 11, textDecoration: 'none', color: 'var(--fl-text)' }}>
          <span aria-hidden style={{ width: 30, height: 30, borderRadius: 8, background: 'linear-gradient(135deg,var(--fl-primary),var(--fl-primary-2))', boxShadow: '0 4px 12px rgba(97,85,245,.32)' }} />
          <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 18, letterSpacing: '-.01em' }}>Flowlink</span>
        </Link>
        <nav aria-label="주요" style={{ display: 'flex', gap: 4 }}>
          <Link to="/flows" style={navItem('/flows')}>대시보드</Link>
          <Link to="/executions" style={navItem('/executions')}>실행 이력</Link>
        </nav>
        <button
          onClick={() => setTheme(toggleTheme())}
          aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          style={{ marginLeft: 'auto', width: 36, height: 36, borderRadius: 'var(--fl-radius-sm)', border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', fontSize: 16 }}
        >
          {theme === 'dark' ? '☀' : '🌙'}
        </button>
      </header>
      <main id="main">{children}</main>
    </div>
  )
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
