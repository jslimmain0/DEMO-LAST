import './workbench.css'
import { AppIcon, type AppIconName } from '../components/AppIcon'
import { useWorkspace } from './WorkspaceContext'
import { FRONTEND_MOCK } from '../lib/frontendMock'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { SettingsDialog } from '../components/SettingsDialog'
import { desktopApi } from '../auth/desktop'
import { ServerInstallCard } from '../components/ServerInstallCard'
import { getTheme, toggleTheme, type Theme } from '../design/theme'
import { ResizeHandle } from '../components/ResizeHandle'
import { rememberWorkbenchLocation, workbenchMenuLink } from '../lib/workbenchNavigation'

const WORK_NAV: Array<{ to: string; label: string; icon: AppIconName }> = [
  { to: '/flows', label: '워크플로', icon: 'flow' },
  { to: '/mocks', label: 'Mock', icon: 'database' },
  { to: '/resources?tab=environments', label: '환경 변수', icon: 'sliders' },
  { to: '/executions', label: '실행 이력', icon: 'clock' },
]
const SHARED_NAV: Array<{ to: string; label: string; icon: AppIconName }> = [
  { to: '/resources?tab=secrets', label: '시크릿', icon: 'key' },
  { to: '/protocols', label: '프로토콜', icon: 'link' },
  { to: '/plugins', label: '플러그인', icon: 'code' },
]
const LOCATION_NAV: Record<string, 'flows' | 'mocks' | 'resources' | 'executions'> = { '/flows': 'flows', '/mocks': 'mocks', '/resources?tab=environments': 'resources', '/executions': 'executions' }

export function AppShellTier1({ children, sidebarExtra }: { children: ReactNode; sidebarExtra?: ReactNode }) {
  const scope = useWorkspace()
  const { enabled: authEnabled, me, logout, isGuest, requestLogin, runtime, desktop } = useAuth()
  const location = useLocation()
  const [theme, setTheme] = useState<Theme>(getTheme())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sideW, setSideW] = useState(() => {
    try { const value = Number(localStorage.getItem(SIDEBAR_KEY)); return value >= SIDEBAR_MIN && value <= SIDEBAR_MAX ? value : SIDEBAR_DEFAULT } catch { return SIDEBAR_DEFAULT }
  })
  const compact = sideW < 140
  const saveSideW = (value: number) => { try { localStorage.setItem(SIDEBAR_KEY, String(value)) } catch { /* private mode */ } }
  const { agentApi } = scope
  const serverAdminApi = useMemo(() => agentApi('server', 'public').adminApi, [agentApi])
  const serverAdmin = useQuery({ queryKey: ['server-admin', scope.remoteKey], queryFn: serverAdminApi.me, enabled: scope.connected, staleTime: 30_000, refetchInterval: 60_000, retry: false })
  const localId = scope.workspaces.find(workspace => workspace.origin === 'local' && workspace.kind === 'PERSONAL')?.id ?? 'local'
  useEffect(() => { rememberWorkbenchLocation(location, scope, localStorage) }, [location, scope])
  const currentSpace = `${scope.current.origin}:${scope.current.id}`
  const navHref = (to: string, central = false) => `${to}${to.includes('?') ? '&' : '?'}space=${encodeURIComponent(central ? 'server:public' : currentSpace)}`
  const active = (to: string) => {
    const [pathname, search] = to.split('?')
    if (!location.pathname.startsWith(pathname)) return false
    if (pathname !== '/resources') return true
    const currentTab = new URLSearchParams(location.search).get('tab') === 'secrets' ? 'secrets' : 'environments'
    return new URLSearchParams(search).get('tab') === currentTab
  }
  const menuLink = (to: string) => LOCATION_NAV[to]
    ? workbenchMenuLink(LOCATION_NAV[to], location, scope, localStorage, desktop ? localId : undefined)
    : { to: navHref(to) }
  const navLink = (item: typeof WORK_NAV[number], central = false) => <div key={item.to}>
    <Link {...(central ? { to: navHref(item.to) } : menuLink(item.to))} className="fl-shell-nav-link" aria-current={active(item.to) ? 'page' : undefined} title={item.label} aria-label={item.label}>
      <AppIcon name={item.icon} size={18} /><span>{item.label}</span>
    </Link>
    {sidebarExtra && ((item.to === '/flows' && location.pathname.startsWith('/flows')) || (item.to === '/mocks' && location.pathname.startsWith('/mocks'))) && <div className="fl-sidebar-folders">{sidebarExtra}</div>}
  </div>
  const pendingCount = (serverAdmin.data?.pendingCount ?? 0) + (serverAdmin.data?.pendingPlugins ?? 0)
  const accountName = desktop ? scope.login ?? '서버 계정' : isGuest ? '게스트' : me?.username
  const connectionStatus = !scope.connected ? '로그인 필요' : scope.remoteError ? '연결 확인 필요' : '연결됨'

  return <div className="fl-app-frame" style={{ display: 'flex', minHeight: '100dvh' }}>
    <a className="fl-workbench-skip" href="#main" style={skipLink}>본문 바로가기</a>
    <aside role="navigation" aria-label="주요" className={`fl-app-sidebar${compact ? ' fl-app-sidebar--compact' : ''}`} style={{ ...sidebar, width: sideW }}>
      <Link {...menuLink('/flows')} className="fl-shell-brand" aria-label="FlowLink 워크플로"><span className="fl-brand-mark"><AppIcon name="flow" size={26} /></span><span>FlowLink</span></Link>
      <div className="fl-sidebar-access" aria-label="작업 위치 바로가기">
        {desktop && <Link to={`/flows?space=${encodeURIComponent(`local:${localId}`)}`} title="내 PC 워크플로" aria-label="내 PC 워크플로"><AppIcon name="monitor" size={16} /><span>내 PC</span><small>개인 작업</small></Link>}
        <Link to={navHref('/workspaces', !FRONTEND_MOCK)} title="서버 공간 탐색" aria-label="서버 공간 탐색"><AppIcon name="workspace" size={16} /><span>서버 공간</span><AppIcon name="chevronRight" size={14} /></Link>
      </div>
      <div className="fl-sidebar-body">
        <nav aria-label="작업" className="fl-shell-nav-group"><span className="fl-shell-nav-label">작업</span>{WORK_NAV.map(item => navLink(item))}</nav>
        <nav aria-label="서버 공통 자원" className="fl-shell-nav-group"><span className="fl-shell-nav-label">서버 공통 자원</span>{SHARED_NAV.map(item => navLink(item, true))}</nav>
        {serverAdmin.data?.admin && <Link to={navHref('/admin', true)} className="fl-shell-nav-link" aria-current={location.pathname === '/admin' ? 'page' : undefined} title="서버 관리" aria-label="서버 관리">
          <AppIcon name="shield" size={18} /><span>서버 관리</span>{pendingCount > 0 && <small className="fl-shell-pending" aria-label={`대기 요청 ${pendingCount}건`}>{pendingCount}</small>}
        </Link>}
        {!desktop && runtime?.kind === 'server' && <ServerInstallCard compact />}
      </div>
      <div className="fl-sidebar-footer">
        <div className="fl-shell-connection" role="status" aria-label={`회사 서버 · ${connectionStatus}`} title={`회사 서버 · ${connectionStatus}`}>
          <span className="fl-shell-status-dot" data-connected={scope.connected && !scope.remoteError} aria-hidden /><span>회사 서버</span><small>{connectionStatus}</small>
        </div>
        {desktop ? <div className="fl-shell-account"><span>{scope.connected ? accountName : '내 PC에서 작업 중'}</span>{scope.connected ? <button onClick={logout} aria-label="서버 로그아웃" title="서버 로그아웃"><AppIcon name="logout" size={16} /></button> : <button onClick={() => void desktopApi.login()} className="fl-shell-login">로그인</button>}</div>
          : authEnabled && me && <div className="fl-shell-account"><span>{accountName}{serverAdmin.data?.myStatus === 'PENDING' && <small>승인 대기 중</small>}</span>{isGuest ? <button onClick={requestLogin} className="fl-shell-login">로그인</button> : <button onClick={logout} aria-label="로그아웃" title="로그아웃"><AppIcon name="logout" size={16} /></button>}</div>}
        <div className="fl-sidebar-preferences"><button onClick={() => setSettingsOpen(true)} aria-label="설정"><AppIcon name="settings" size={17} /><span>설정</span></button><button onClick={() => setTheme(toggleTheme())} aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}><AppIcon name={theme === 'dark' ? 'sun' : 'moon'} size={17} /><span>{theme === 'dark' ? '라이트' : '다크'}</span></button></div>
      </div>
    </aside>
    <div className="fl-app-sidebar-handle"><ResizeHandle axis="x" sign={1} size={sideW} min={SIDEBAR_MIN} max={SIDEBAR_MAX} defaultSize={SIDEBAR_DEFAULT} onResize={setSideW} onResizeEnd={saveSideW} ariaLabel="사이드바 너비" /></div>
    <main id="main" className="fl-app-main" style={{ flex: 1, minWidth: 0 }}>{children}</main>
    {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
  </div>
}

const SIDEBAR_KEY = 'fl:shell:sidebarW'
const SIDEBAR_MIN = 64
const SIDEBAR_MAX = 420
const SIDEBAR_DEFAULT = 224
const sidebar: CSSProperties = { flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 18, padding: '22px 14px 14px', background: 'var(--fl-surface)', position: 'sticky', top: 0, height: '100dvh', boxSizing: 'border-box', overflow: 'hidden' }
const skipLink: CSSProperties = { position: 'absolute', left: -9999, top: 8, zIndex: 100, padding: '8px 14px', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-action-primary-bg)', color: 'var(--fl-action-primary-ink)', fontSize: 13, fontWeight: 600, textDecoration: 'none' }
