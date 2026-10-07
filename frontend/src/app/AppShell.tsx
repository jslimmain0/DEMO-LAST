import './workbench.css'
import { AppIcon, type AppIconName } from '../components/AppIcon'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useQuery } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { useAuth } from '../auth/AuthContext'
import { SettingsDialog } from '../components/SettingsDialog'
import { desktopApi } from '../auth/desktop'
import { ServerInstallCard } from '../components/ServerInstallCard'
import { WorkspaceSwitcher } from '../components/WorkspaceSwitcher'
import { getTheme, toggleTheme, type Theme } from '../design/theme'
import { ui } from '../design/ui'
import { ResizeHandle } from '../components/ResizeHandle'

const NAV: Array<{to: string; label: string; icon: AppIconName}> = [
  { to: '/flows', label: '워크플로', icon: 'flow' },
  { to: '/resources', label: '환경 · 시크릿', icon: 'lock' },
  { to: '/mocks', label: 'Mock 서버', icon: 'database' },
  { to: '/protocols', label: '프로토콜', icon: 'link' },
  { to: '/plugins', label: '플러그인 목록', icon: 'code' },
  { to: '/executions', label: '실행 이력', icon: 'clock' },
]
// 관리 콘솔 — 관리자에게만 노출(백엔드 /admin/* 도 403 으로 이중 방어)
const NAV_ADMIN: {to: string; label: string; icon: AppIconName} = { to: '/admin?space=server%3Apublic', label: '서버 관리', icon: 'shield' }

/** 앱 전역 셸 — 공간·메뉴를 탐색하는 사이드바 + 우측 작업면.
 *  sidebarExtra: 페이지가 사이드바에 덧붙이는 컨텍스트 UI(예: 대시보드의 폴더 목록). */
export function AppShellTier1({ children, sidebarExtra }: { children: ReactNode; sidebarExtra?: ReactNode }) {
  const { adminApi } = useApi()
  const scope = useWorkspace()

  const [theme, setTheme] = useState<Theme>(getTheme())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 사이드바 너비 — 드래그로 64~420px. 140px 미만이면 아이콘만 보이는 좁은 모드.
  const [sideW, setSideW] = useState(() => {
    try { const v = Number(localStorage.getItem(SIDEBAR_KEY)); return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : SIDEBAR_DEFAULT } catch { return SIDEBAR_DEFAULT }
  })
  const compact = sideW < 140
  const saveSideW = (n: number) => { try { localStorage.setItem(SIDEBAR_KEY, String(n)) } catch { /* 저장 불가 환경 */ } }
  const loc = useLocation()
  const library = loc.pathname === '/workspaces'
  const administration = loc.pathname === '/admin'
  const { enabled: authEnabled, me, logout, isGuest, requestLogin, runtime, desktop } = useAuth()
  // 관리자 여부 + 가입 신청 배지 — 60초 폴링으로 새 신청이 네비에 늦지 않게 뜬다(콘솔 진입 시에도 refetch)
  const adminMe = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000, refetchInterval: 60_000 })
  const { agentApi } = scope
  const serverAdminApi = useMemo(() => agentApi('server', 'public').adminApi, [agentApi])
  const serverAdmin = useQuery({ queryKey: ['server-admin', scope.remoteKey], queryFn: serverAdminApi.me, enabled: scope.connected, staleTime: 30_000, refetchInterval: 60_000, retry: false })
  const myStatus = adminMe.data?.myStatus

  const navItem = (to: string): CSSProperties => {
    const active = loc.pathname.startsWith(to.split('?')[0])
    return {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '9px 10px',
      borderRadius: 'var(--fl-radius-sm)',
      textDecoration: 'none',
      fontSize: 14,
      fontWeight: active ? 600 : 500,
      color: active ? 'var(--fl-text)' : 'var(--fl-text-soft)',
      background: active ? 'var(--fl-surface-2)' : 'transparent',
      border: '1px solid transparent',
    }
  }

  return (
    <div className="fl-app-frame" style={{ display: 'flex', minHeight: '100dvh' }}>
      <a className="fl-workbench-skip" href="#main" style={skipLink}>본문 바로가기</a>

      <aside role="navigation" aria-label="주요" className={`fl-app-sidebar${compact ? ' fl-app-sidebar--compact' : ''}`} style={{ ...sidebar, width: sideW }}>
        <Link to="/flows" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', color: 'var(--fl-text)', padding: '4px 8px 0' }}>
          <span className="fl-brand-mark"><AppIcon name="flow" size={28} /></span>
          <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 750, fontSize: 20, letterSpacing: '-.025em' }}>FlowLink</span>
        </Link>

        {library && <Link to="/workspaces" className="fl-workspace-back">워크스페이스</Link>}
        <div style={{ display: 'grid', gap: 4, flexShrink: 0 }}>
          {!library && <WorkspaceSwitcher />}
          {desktop && !scope.connected && <button onClick={() => void desktopApi.login()} style={{ ...themeBtn, marginTop: 0 }}>＋ 서버 로그인</button>}
        </div>

        <div className="fl-sidebar-body">
        <nav style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 2 }}>
          {!library && NAV.map((n) => n.to === '/plugins' && scope.current.origin === 'local' ? null : (<div key={n.to}>
            <Link key={n.to} to={n.to} style={navItem(n.to)} title={compact ? n.label : undefined} aria-label={compact ? n.label : undefined}>
              <AppIcon name={n.icon} size={19} style={loc.pathname.startsWith(n.to.split('?')[0]) ? { color: 'var(--fl-primary)' } : undefined} />
              <span>{n.label}</span>
            </Link>
            {n.to === '/flows' && sidebarExtra && <div className="fl-sidebar-folders">{sidebarExtra}</div>}
            </div>
          ))}
        </nav>

        {serverAdmin.data?.admin && <Link to={NAV_ADMIN.to} style={{ ...navItem(NAV_ADMIN.to), marginTop: 8 }} title={compact ? NAV_ADMIN.label : undefined} aria-label={compact ? NAV_ADMIN.label : undefined}>
          <AppIcon name="shield" size={18} /><span>{NAV_ADMIN.label}</span>
          {(serverAdmin.data.pendingCount + (serverAdmin.data.pendingPlugins ?? 0)) > 0 && <span style={pendingNavBadge} aria-label={`대기 요청 ${serverAdmin.data.pendingCount + (serverAdmin.data.pendingPlugins ?? 0)}건`}>{serverAdmin.data.pendingCount + (serverAdmin.data.pendingPlugins ?? 0)}</span>}
        </Link>}

        {!desktop && runtime?.kind === 'server' && <ServerInstallCard compact />}
        </div>
        <div className="fl-sidebar-footer">
        <div className="fl-runtime-status" style={{ padding: '10px 8px 0', fontSize: 12, color: 'var(--fl-text-muted)' }}>
          {desktop && <span><AppIcon name="monitor" size={16} /><b>로컬</b><small style={{ color: 'var(--fl-ok)' }}>● 준비됨</small></span>}
          <span><AppIcon name="database" size={16} /><b>서버</b><small style={{ color: scope.connected && !scope.remoteError ? 'var(--fl-ok)' : 'var(--fl-text-muted)' }}>● {scope.connected ? scope.remoteError ? '연결 끊김' : '연결됨' : '로그인 필요'}</small></span>
        </div>
        {desktop && <div style={{ ...userChip, marginTop: 'auto' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, overflowWrap: 'anywhere', lineHeight: 1.5 }}><strong style={{ display: 'block', fontWeight: 600 }}>{scope.connected ? scope.login ?? '사용자' : '개인 공간 사용 중'}</strong>{scope.connected && <small style={{ display: 'block', color: 'var(--fl-text-muted)', fontSize: 12 }}>서버 로그인됨</small>}</span>
          {scope.connected ? <button onClick={logout} aria-label="서버 로그아웃" style={logoutBtn}>⎋</button> : <button onClick={() => setSettingsOpen(true)} style={loginChipBtn}>연결</button>}
        </div>}

        {authEnabled && me && (
          <div style={{ ...userChip, marginTop: 'auto' }} title={isGuest ? '게스트 — GitHub 로그인하면 AI 를 쓸 수 있습니다' : myStatus === 'PENDING' ? '관리자 승인 대기 중 — 팀·AI 는 승인 후 사용 가능' : `${me.username} · ${me.tenant} · ${me.roles.join(', ')}`}>
            <span aria-hidden style={avatar}>{isGuest ? 'G' : me.username.slice(0, 1).toUpperCase()}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isGuest ? '게스트' : me.username}</span>
              <span style={{ display: 'block', fontSize: 12, color: myStatus === 'PENDING' ? 'var(--fl-waiting)' : 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {isGuest ? 'AI 는 로그인 필요' : myStatus === 'PENDING' ? '승인 대기 중' : `${me.tenant} · ${primaryRole(me.roles)}`}
              </span>
            </span>
            {isGuest ? (
              <button onClick={requestLogin} title="GitHub 로그인" style={loginChipBtn}>로그인</button>
            ) : (
              <button onClick={logout} aria-label="로그아웃" title="로그아웃" style={logoutBtn}>⎋</button>
            )}
          </div>
        )}
        <div className="fl-sidebar-preferences"><button onClick={() => setSettingsOpen(true)} aria-label="설정" style={{ ...themeBtn, marginTop: desktop || authEnabled && me ? 0 : 'auto' }}>
          <AppIcon name="settings" />
          <span>설정</span>
        </button>
        <button
          onClick={() => setTheme(toggleTheme())}
          aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
          style={{ ...themeBtn, marginTop: 0 }}
        >
          <AppIcon name={theme === 'dark' ? 'sun' : 'moon'} />
          <span>{theme === 'dark' ? '라이트' : '다크'}</span>
        </button></div>
        </div>
      </aside>
      <div className="fl-app-sidebar-handle">
        <ResizeHandle axis="x" sign={1} size={sideW} min={SIDEBAR_MIN} max={SIDEBAR_MAX} defaultSize={SIDEBAR_DEFAULT} onResize={setSideW} onResizeEnd={saveSideW} ariaLabel="사이드바 너비" />
      </div>

      <main id="main" className="fl-app-main" style={{ flex: 1, minWidth: 0 }}>{administration && <div className="fl-workbench-context"><b>{scope.current.origin === 'local' ? '내 PC 관리' : '서버 관리'}</b><span>{scope.current.origin === 'local' ? '이 PC의 개인 자원' : '현재 서버 계정의 관리 범위'}</span></div>}{children}</main>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

const SIDEBAR_KEY = 'fl:shell:sidebarW'
const SIDEBAR_MIN = 64
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 232

const sidebar: CSSProperties = {
  width: SIDEBAR_DEFAULT,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '22px 14px 14px',
  background: 'var(--fl-surface)',
  position: 'sticky',
  top: 0,
  height: '100dvh',
  boxSizing: 'border-box',
  overflowY: 'hidden',
  overflowX: 'hidden',
  scrollbarGutter: 'stable',
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
  color: 'var(--fl-action-primary-ink)',
  background: 'var(--fl-action-primary-bg)',
}
const logoutBtn: CSSProperties = {
  flexShrink: 0,
  border: 'none',
  background: 'transparent',
  color: 'var(--fl-text-muted)',
  cursor: 'pointer',
  fontSize: 14,
  padding: 4,
}
const loginChipBtn: CSSProperties = { ...ui.secondary, flexShrink: 0, color: 'var(--fl-primary)' }
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
  fontSize: 14,
  fontWeight: 500,
  fontFamily: 'inherit',
  textAlign: 'left',
}
const pendingNavBadge: CSSProperties = {
  marginLeft: 'auto',
  minWidth: 18,
  height: 18,
  padding: '0 5px',
  borderRadius: 'var(--fl-radius)',
  display: 'inline-grid',
  placeItems: 'center',
  background: 'var(--fl-waiting)',
  color: '#1a1d27',
  fontSize: 11,
  fontWeight: 800,
}
const skipLink: CSSProperties = {
  position: 'absolute',
  left: -9999,
  top: 8,
  background: 'var(--fl-action-primary-bg)',
  color: 'var(--fl-action-primary-ink)',
  padding: '8px 14px',
  borderRadius: 'var(--fl-radius)',
  zIndex: 100,
}
