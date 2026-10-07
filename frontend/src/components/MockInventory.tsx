import { AppIcon, type AppIconName } from './AppIcon'
import { useApi } from '../app/WorkspaceContext'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { HttpMethod, MockFleet, MockFleetPort, MockFleetServer, MockFleetWorkspace } from '../api/types'

import { METHOD_COLOR } from '../canvas/nodeMeta'
import { relTime } from '../lib/format'
import { toast } from './toast'
import { CatalogPagination } from './CatalogPagination'
import { catalogPage, compareMocks, type MockSort } from '../lib/catalog'
import { ui } from '../design/ui'

export type ServerAction = 'toggle' | 'rename' | 'duplicate' | 'export' | 'delete' | 'fav' | 'copyUrl' | 'move' | 'goFlow'
export type FleetFilter = 'all' | 'on' | 'off' | 'fail' | 'live' | 'unmatched' | 'fav'
export type ServerState = 'on' | 'off' | 'fail'
export function serverState(s: MockFleetServer): ServerState {
  if (s.listener) return s.listener.state === 'LISTENING' ? 'on' : s.listener.state === 'FAILED' ? 'fail' : 'off'
  return s.kind === 'TCP' ? (s.listening ? 'on' : s.listenError ? 'fail' : 'off') : (s.enabled ? 'on' : 'off')
}
const kindColorOf = (isTcp: boolean) => (isTcp ? 'var(--fl-cat-tcp)' : 'var(--fl-cat-http)')

/**
 * Mock 서버 인벤토리 — Mock 화면의 유일한 보기. Docker Desktop/Mockoon 식 **행 목록**을 워크스페이스로 묶는다(에이전트 토론 결론: 그래프 폐기).
 * - 상단 **포트 스트립**: 실제 리스너 기준 칩(● 리스닝 / ✕ 바인딩 실패, 꺼짐은 `+N 꺼짐` 으로 접음). 칩 클릭 = 그 행으로 스크롤+하이라이트.
 * - **워크스페이스 그룹**: 내 소속(공용·내 개인·멤버인 팀) 먼저 펼침, 남의 것은 접힘 + 🔒(읽기 전용/접근 없음). 헤더에 롤·서버/서빙 수·포트·**+ Mock**.
 *   검색/필터 중엔 안 맞는 행을 숨기고(`N/M`) 일치가 있는 그룹은 자동으로 펼친다. 접힘은 localStorage.
 * - **행** = 한 서버: LED(◉ 요청 중 펄스 · ● 서빙/리스닝 · ✕ 실패 · ○ 꺼짐) → **이름** + 연결 주소·복사 → 종류·상태 → 구성(라우트 필 / 필드·규칙) → 트래픽(60초·마지막 요청·무매칭) → ↗ 워크플로 → vN → ⏻ ⋯(항상 표시).
 *   꺼짐=회색 상태 표시, 접근 불가=이름·포트·상태만. 클릭=편집기, Ctrl/Shift+클릭 또는 선택 모드=선택.
 */
export function MockInventory({ fleet, host, tenant, match, sort = 'name', pageNumber, pageSize, onPage, onSize, selected, selectMode, favs, canEditGlobal, wsOptions, onOpen, onToggleSelect, onAction, onCreateIn }: {
  fleet: MockFleet
  host: string
  tenant?: string | null
  match: ((s: MockFleetServer) => boolean) | null   // null = 전부 표시
  sort?: MockSort
  pageNumber: number
  pageSize: number
  onPage: (page: number) => void
  onSize: (size: number) => void
  selected: Set<string>
  selectMode: boolean
  favs: Set<string>
  canEditGlobal: boolean
  wsOptions: MockFleetWorkspace[]
  onOpen: (s: MockFleetServer) => void
  onToggleSelect: (s: MockFleetServer) => void
  onAction: (s: MockFleetServer, action: ServerAction, arg?: string) => void
  onCreateIn: (wsId: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem('fl:mock:groups') ?? '{}') as Record<string, boolean> } catch { return {} } })
  const toggleGroup = (id: string, mineDefault: boolean) => setCollapsed((c) => { const cur = c[id] ?? !mineDefault; const n = { ...c, [id]: !cur }; try { localStorage.setItem('fl:mock:groups', JSON.stringify(n)) } catch { /* */ } return n })
  const [flash, setFlash] = useState<string | null>(null)
  const [showOff, setShowOff] = useState(false)
  const [showPorts, setShowPorts] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)

  const groups = useMemo(() => {
    const byWs = new Map<string, MockFleetServer[]>()
    for (const s of fleet.servers) { const a = byWs.get(s.workspaceId) ?? []; a.push(s); byWs.set(s.workspaceId, a) }
    // 켜진 것 → HTTP 먼저 → 포트 → 이름
    for (const a of byWs.values()) a.sort(compareMocks(sort, serverState))
    const rank = (w: MockFleetWorkspace) => (w.kind === 'PUBLIC' ? 0 : w.kind === 'PERSONAL' ? 1 : 2)
    return [...fleet.workspaces]
      .sort((a, b) => Number(b.mine) - Number(a.mine) || rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'))
      .filter((w) => w.mine || (byWs.get(w.id)?.length ?? 0) > 0)
      .map((w) => { const all = byWs.get(w.id) ?? []; return { ws: w, all, shown: match ? all.filter(match) : all } })
  }, [fleet, match, sort])
  const searching = match != null

  const focusRow = (id: string) => {
    const group = groups.find(g => g.shown.some(s => s.id === id))
    if (!group) { toast('이 Mock은 검색·필터에 가려져 있습니다. 필터를 초기화하고 다시 선택하세요.', 'error'); return }
    const index = group.shown.findIndex(s => s.id === id)
    setCollapsed(c => ({ ...c, [group.ws.id]: false }))
    onPage(Math.floor(index / pageSize) + 1)
    setFocusId(id)
  }
  useEffect(() => {
    if (!focusId) return
    const el = document.getElementById(`mock-row-${focusId}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus({ preventScroll: true })
    setFlash(focusId); setFocusId(null)
  }, [focusId, pageNumber])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(timer)
  }, [flash])

  const ports = fleet.ports
  const offPorts = ports.filter((p) => p.kind === 'TCP' && p.state === 'OFF')
  return (
    <div className="fl-mock-inventory" style={{ display: 'grid', gap: 14 }}>
      {/* 포트 스트립 — 실제 리스너 기준 */}
      <details style={{ order: 2 }}>
      <summary style={{ ...meta, cursor: 'pointer', padding: '8px 0' }}>연결 정보 · {host} · 열린 포트 {ports.filter(p => p.state === 'LISTENING').length}개{ports.some(p => p.state === 'FAILED') ? ' · 바인딩 실패 있음' : ''}</summary>
      <div style={portRow} aria-label="포트 맵">
        <span style={{ ...meta, fontWeight: 700, color: 'var(--fl-text)', marginRight: 2 }}>포트</span>
        {ports.filter((p) => p.kind === 'HTTP' || p.state !== 'OFF').slice(0, showPorts ? undefined : 8).map((p, i) => (
          <PortChip key={`${p.port}-${p.mockId ?? 'http'}-${i}`} p={p} host={host} contextPath={fleet.contextPath} tenant={tenant} onOpen={() => { if (p.mockId) focusRow(p.mockId) }} />
        ))}
        {ports.filter(p => p.kind === 'HTTP' || p.state !== 'OFF').length > 8 && <button onClick={() => setShowPorts(v => !v)} aria-expanded={showPorts} style={portChip}>{showPorts ? '포트 접기' : `포트 ${ports.filter(p => p.kind === 'HTTP' || p.state !== 'OFF').length - 8}개 더 보기`}</button>}
        {offPorts.length > 0 && (
          <button onClick={() => setShowOff((v) => !v)} aria-expanded={showOff} style={{ ...portChip, borderStyle: 'dashed', opacity: 0.8, cursor: 'pointer' }} title="꺼진 TCP Mock 의 포트(리스너 닫힘)">
            <AppIcon name={showOff ? 'chevronDown' : 'chevronRight'} size={13} style={{ color: 'var(--fl-text-muted)', verticalAlign: '-2px' }} /> 꺼짐 {offPorts.length}
          </button>
        )}
        {showOff && offPorts.map((p, i) => <PortChip key={`off-${p.port}-${i}`} p={p} host={host} contextPath={fleet.contextPath} tenant={tenant} onOpen={() => { if (p.mockId) focusRow(p.mockId) }} />)}
      </div>
      </details>

      {/* 워크스페이스 그룹 */}
      {groups.map(({ ws: w, all, shown }) => {
        const readable = w.myRole != null
        const writable = canEditGlobal && (w.myRole === 'OWNER' || w.myRole === 'EDITOR')
        const isCollapsed = groups.length > 1 && (searching ? shown.length === 0 : (collapsed[w.id] ?? !w.mine))
        const page = catalogPage(shown.length, pageNumber, pageSize)
        const on = all.filter((s) => serverState(s) === 'on').length
        const live = all.filter((s) => s.recentRequests > 0).length
        const tcpPorts = all.filter((s) => s.tcpPort != null).sort((a, b) => (a.tcpPort ?? 0) - (b.tcpPort ?? 0))
        const icon: AppIconName = w.kind === 'PERSONAL' ? 'monitor' : w.kind === 'TEAM' ? 'workspace' : 'globe'
        const roleLabel = !readable ? '접근 없음' : w.myRole === 'VIEWER' ? '읽기 전용' : w.myRole === 'OWNER' ? (w.mine ? '소유' : '관리자') : '편집'
        const roleColor = !readable ? 'var(--fl-fail)' : w.myRole === 'VIEWER' ? 'var(--fl-put, #f5a623)' : 'var(--fl-ok)'
        return (
          <section key={w.id} aria-label={`워크스페이스 ${w.name}`} data-mine={w.mine} style={groups.length === 1 ? groupBoxSolo : { ...groupBox, borderStyle: w.mine ? 'solid' : 'dashed' }}>
            <div style={{ ...groupHead, ...(groups.length === 1 ? { display: 'none' } : {}) }}>
              <button onClick={() => toggleGroup(w.id, w.mine)} aria-expanded={!isCollapsed} style={chev} title={isCollapsed ? '펼치기' : '접기'}><AppIcon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={13} style={{ color: 'var(--fl-text-muted)', verticalAlign: '-2px' }} /></button>
              <AppIcon name={icon} size={16} />
              <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 800, fontSize: 14, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
              <span style={{ ...roleChip, color: roleColor, borderColor: `color-mix(in srgb, ${roleColor} 40%, var(--fl-border))` }}>{(!readable || w.myRole === 'VIEWER') && ''}{roleLabel}</span>
              <span style={meta}>서버 {searching ? `${shown.length}/${all.length}` : all.length} · 서빙 {on}{live ? ` · 요청 중 ${live}` : ''}</span>
              {tcpPorts.length > 0 && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{tcpPorts.slice(0, 6).map((s) => <span key={s.id} style={{ ...portMini, color: serverState(s) === 'on' ? 'var(--fl-ok)' : serverState(s) === 'fail' ? 'var(--fl-fail)' : 'var(--fl-text-muted)' }}>:{s.tcpPort}</span>)}{tcpPorts.length > 6 && <span style={portMini}>+{tcpPorts.length - 6}</span>}</span>}
              {writable && <button onClick={() => onCreateIn(w.id)} style={{ ...ghostMini, marginLeft: 'auto' }} title="이 워크스페이스에 새 Mock 만들기">+ Mock</button>}
            </div>
            {!isCollapsed && (
              all.length === 0
                ? <p style={{ ...meta, margin: '4px 0 6px 30px' }}>이 워크스페이스에는 아직 Mock 서버가 없습니다.</p>
                : <><div className="fl-table-wrap" style={{ overflowX: 'auto' }}>
                    <div className="fl-mock-table-grid" style={{ minWidth: 730 }}>
                      <div data-select-mode={selectMode} className="fl-mock-table-heading" style={{ ...rowGrid, gridTemplateColumns: `${selectMode ? '18px ' : ''}${rowGrid.gridTemplateColumns}`, ...headRow }} aria-hidden>
                        {selectMode && <span />}<span /><span>Mock 이름 · 연결 주소</span><span>종류 · 상태</span><span>응답 구성</span><span>최근 요청</span><span style={{ textAlign: 'right' }}>작업</span>
                      </div>
                      {shown.slice(page.start, page.end).map((s) => (
                        <InventoryRow key={s.id} s={s} host={host} tenant={tenant} httpPort={fleet.httpPort} contextPath={fleet.contextPath}
                          selected={selected.has(s.id)} selectMode={selectMode} fav={favs.has(s.id)} editable={canEditGlobal && s.readable && s.myRole !== 'VIEWER'} wsOptions={wsOptions}
                          flash={flash === s.id} onOpen={onOpen} onToggleSelect={onToggleSelect} onAction={onAction} />
                      ))}
                    </div>
                  </div><CatalogPagination label={`${w.name} Mock`} total={shown.length} page={page.page} size={pageSize} onPage={onPage} onSize={onSize} /></>
            )}
          </section>
        )
      })}
    </div>
  )
}

// ---------- 행 ----------

function InventoryRow({ s, host, tenant, httpPort, contextPath, selected, selectMode, fav, editable, wsOptions, flash, onOpen, onToggleSelect, onAction }: {
  s: MockFleetServer; host: string; tenant?: string | null; httpPort: number; contextPath: string
  selected: boolean; selectMode: boolean; fav: boolean; editable: boolean; wsOptions: MockFleetWorkspace[]; flash: boolean
  onOpen: (s: MockFleetServer) => void; onToggleSelect: (s: MockFleetServer) => void; onAction: (s: MockFleetServer, action: ServerAction, arg?: string) => void
}) {
  const { mockBaseUrl } = useApi()

  const [menu, setMenu] = useState(false)
  const [flows, setFlows] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 })
  const toggleMenu = () => {
    if (!menu) {
      const rect = menuButton.current!.getBoundingClientRect()
      setMenuPosition({ left: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 360)) })
    }
    setMenu(v => !v)
  }
  useEffect(() => {
    if (!menu) return
    popupRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const inside = (target: EventTarget | null) => menuRef.current?.contains(target as Node) || popupRef.current?.contains(target as Node)
    const onDoc = (e: MouseEvent) => { if (!inside(e.target)) { setMenu(false); setFlows(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); setFlows(false); menuButton.current?.focus() } }
    const onMove = (e: Event) => { if (!(e.target instanceof Node) || !popupRef.current?.contains(e.target)) setMenu(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onMove); document.addEventListener('scroll', onMove, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onMove); document.removeEventListener('scroll', onMove, true) }
  }, [menu])
  const st = serverState(s)
  const isTcp = s.kind === 'TCP'
  const live = s.recentRequests > 0
  const kindColor = kindColorOf(isTcp)
  const ledColor = st === 'on' ? 'var(--fl-ok)' : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, #9aa0b2)'
  const readOnly = !s.readable || s.myRole === 'VIEWER'
  const seg = tenant && tenant !== 'default' ? `${tenant}/${s.slug}` : s.slug
  const port = isTcp ? (s.tcpPort != null ? `:${s.tcpPort}` : ':—') : `:${httpPort}`
  const tail = isTcp ? (s.listener?.advertisedAddress ?? host) : `${contextPath}${s.basePath ?? `/mock/${seg}`}`
  const stateLabel = isTcp ? (st === 'on' ? '리스닝' : st === 'fail' ? '바인딩 실패' : '꺼짐') : (st === 'on' ? '서빙 중' : '꺼짐')
  const usedBy = s.usedBy ?? []
  const act = (action: ServerAction, arg?: string) => { setMenu(false); setFlows(false); menuButton.current?.focus(); onAction(s, action, arg) }
  const click = (e: React.MouseEvent) => { if (selectMode || e.ctrlKey || e.metaKey || e.shiftKey) onToggleSelect(s); else if (s.readable) onOpen(s) }
  const labels = s.routeLabels
  return (
    <div id={`mock-row-${s.id}`} className={`fl-mock-row${flash ? ' fl-row-flash' : ''}`} role={s.readable || selectMode ? 'button' : undefined} tabIndex={s.readable || selectMode ? 0 : -1} aria-pressed={selectMode ? selected : undefined}
      data-select-mode={selectMode} data-state={st} data-kind={isTcp ? 'TCP' : 'HTTP'} data-readable={s.readable} data-selected={selected ? 'true' : undefined}
      onClick={click} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); if (selectMode) onToggleSelect(s); else if (s.readable) onOpen(s) } }}
      title={!s.readable ? '접근 권한이 없는 워크스페이스 — 이름·포트·상태만 보입니다' : undefined}
      style={{ ...rowGrid, gridTemplateColumns: `${selectMode ? '18px ' : ''}${rowGrid.gridTemplateColumns}`, ...row, cursor: s.readable || selectMode ? 'pointer' : 'not-allowed', boxShadow: selected ? 'inset 0 0 0 2px var(--fl-primary)' : undefined, background: selected ? 'color-mix(in srgb, var(--fl-primary) 7%, var(--fl-surface))' : undefined }}>
      {selectMode && <input type="checkbox" checked={selected} readOnly tabIndex={-1} aria-label={`${s.name} 선택`} style={{ width: 14, height: 14, accentColor: 'var(--fl-primary)', margin: 0, pointerEvents: 'none' }} />}
      <span className={live ? 'fl-led-live' : undefined} style={{ ...led, background: ledColor }} aria-label={`상태 ${stateLabel}${live ? ' · 요청 중' : ''}`} />
      <span className="fl-mock-identity" style={{ display: 'grid', gap: 5, minWidth: 0 }}>
        <span style={{ fontWeight: 650, fontSize: 14, color: 'var(--fl-text)', overflowWrap: 'anywhere', lineHeight: 1.45 }} title={s.currentVersion > 0 ? `v${s.currentVersion}${s.updatedAt ? ` · 수정 ${new Date(s.updatedAt).toLocaleString()}` : ''}` : undefined}>
          {fav && <span aria-label="즐겨찾기" style={{ color: 'var(--fl-put, #f5a623)', marginRight: 5 }}>★</span>}{s.name}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ ...mono, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={isTcp ? `${host}${port}` : mockBaseUrl(s.slug, tenant, s.basePath)}>{isTcp ? `${tail}${tail.endsWith(port) ? '' : port}` : `:${httpPort} /${s.slug}`}</span>
          {!isTcp && s.readable && <button className="fl-hover-reveal" style={{ ...ui.icon, width: 22, height: 22, flexShrink: 0 }} aria-label={`${s.name} 주소 복사`} title="주소 복사" onClick={e => { e.stopPropagation(); onAction(s, 'copyUrl') }}><AppIcon name="copy" size={13} /></button>}
        </span>
      </span>
      <span className="fl-mock-state" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
        <span style={{ ...kindTag, color: kindColor }}>{isTcp ? 'TCP' : 'HTTP'}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: st === 'off' ? 'var(--fl-text-muted)' : ledColor }} title={s.listenError ?? undefined}>{stateLabel}</span>
        {st === 'fail' && <span style={{ ...badge, background: 'var(--fl-fail)' }} title={s.listenError ?? '바인딩 실패'}>!</span>}
        {readOnly && <span style={{ fontSize: 11 }} title={!s.readable ? '접근 권한 없음' : '읽기 전용'}><AppIcon name="lock" size={12} /></span>}
      </span>
      <span className="fl-mock-response" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }} aria-label={!isTcp && s.readable ? '라우트' : undefined}>
        {!s.readable ? <span style={meta}>{isTcp ? `규칙 ${s.tcpRuleCount}` : `라우트 ${s.routeCount}`} · 정의 비공개</span>
          : isTcp ? <span style={{ ...meta, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`프로토콜 ${s.protocolName ?? '없음'} · 규칙 ${s.tcpRuleCount}${s.upstream ? ` · proxy→${s.upstream}` : ''}${s.environment ? ` · 시크릿 환경 ${s.environment}` : ''}`}>{s.protocolName ?? '프로토콜 없음'} · 규칙 {s.tcpRuleCount}{s.upstream ? ` · proxy→${s.upstream}` : ''}{s.environment ? ` · 🔑${s.environment}` : ''}</span>
          : labels.length > 0 ? <>
              {labels.slice(0, 3).map((l, i) => { const sp = l.indexOf(' '); const m = sp > 0 ? l.slice(0, sp) : 'ANY'; const p = sp > 0 ? l.slice(sp + 1) : l; return <span key={i} style={routePill} title={l}><b style={{ color: METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-text-muted)', fontSize: 11 }}>{m}</b><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{p}</span></span> })}
              {s.routeCount > 3 && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }}>+{s.routeCount - 3}</span>}
              {s.hasCodec && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }} title="코덱">◈</span>}
              {s.environment && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }} title="시크릿 환경">{s.environment}</span>}
            </>
          : <span style={meta}>라우트 없음</span>}
        {usedBy.length > 0 && <span style={{ ...meta, flexBasis: '100%' }} title={usedBy.map(f => f.name).join(', ')}>워크플로 {usedBy.length}개에서 사용</span>}
      </span>
      <span className="fl-mock-recent" style={{ ...meta, overflowWrap: 'anywhere', lineHeight: 1.6 }}>
        {live && <span style={{ color: 'var(--fl-ok)', fontWeight: 700 }}>● {s.recentRequests}건/60초 · </span>}
        {s.lastRequestAt ? relTime(s.lastRequestAt) : '요청 없음'}
        {s.unmatchedRequests > 0 && <span style={{ color: 'var(--fl-fail)', fontWeight: 700 }} title="규칙에 안 맞은 요청"> · 무매칭 {s.unmatchedRequests}</span>}
      </span>
      <span ref={menuRef} className="fl-mock-tools" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} style={{ position: 'relative', display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        {editable && <button onClick={() => act('toggle')} aria-label={`${s.name} ${s.enabled ? '끄기' : '켜기'}`} title={s.enabled ? '끄기' : '켜기'} style={{ ...toolBtn, color: s.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)' }}>⏻</button>}
        {s.readable && <button ref={menuButton} onClick={toggleMenu} aria-label={`${s.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu} title="작업" style={toolBtn}>⋯</button>}
        {menu && createPortal(
          <div ref={popupRef} role="menu" aria-label={`${s.name} 작업`} style={{ ...menuBox, ...menuPosition }} onClick={e => e.stopPropagation()} onBlur={e => { if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget) && !menuRef.current?.contains(e.relatedTarget)) setMenu(false) }} onKeyDown={e => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.target instanceof HTMLSelectElement) return
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
            e.preventDefault(); items[next]?.focus()
          }}>
            <button role="menuitem" style={menuItem} onClick={() => act('fav')}>{fav ? '☆ 즐겨찾기 해제' : '★ 즐겨찾기'}</button>
            {!isTcp && <button role="menuitem" style={menuItem} onClick={() => act('copyUrl')}>⧉ base URL 복사</button>}
            {editable && <button role="menuitem" style={menuItem} onClick={() => act('toggle')}>{s.enabled ? '○ 끄기' : '● 켜기'}</button>}
            {editable && <button role="menuitem" style={menuItem} onClick={() => act('rename')}>✎ 이름 바꾸기</button>}
            {editable && <button role="menuitem" style={menuItem} onClick={() => act('duplicate')}>⧉ 복제</button>}
            <button role="menuitem" style={menuItem} onClick={() => act('export')}>⬆ 내보내기</button>
            {usedBy.length > 0 && (
              <>
                <button role="menuitem" style={menuItem} onClick={() => setFlows((v) => !v)} aria-expanded={flows}>↗ 워크플로 {usedBy.length}{flows ? ' ▴' : ' ▾'}</button>
                {flows && usedBy.map((f) => <button key={f.id} role="menuitem" style={{ ...menuItem, paddingLeft: 22, fontSize: 12 }} onClick={() => act('goFlow', f.id)}>↗ {f.name}</button>)}
              </>
            )}
            {editable && wsOptions.length > 1 && (
              <>
                <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--fl-text-muted)' }}>워크스페이스로 이동</div>
                <select aria-label="이동할 워크스페이스" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={menuSelect}>
                  <option value="">이동할 공간 선택…</option>
                  {wsOptions.filter(w => w.id !== s.workspaceId).map((w) => <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '개인 ·' : w.kind === 'TEAM' ? '팀 ·' : '공용 ·'} {w.name} · ID {w.id.slice(0, 8)}</option>)}
                </select>
                <button role="menuitem" disabled={!moveTo} style={menuItem} onClick={() => act('move', moveTo)}>선택한 공간으로 이동</button>
              </>
            )}
            {editable && <button role="menuitem" style={{ ...menuItem, color: 'var(--fl-fail)' }} onClick={() => act('delete')}><AppIcon name="trash" size={15} /> 삭제</button>}
            <button role="menuitem" style={menuItem} onClick={() => { setMenu(false); onToggleSelect(s) }}>{selected ? '☐ 선택 해제' : '☑ 선택'}</button>
          </div>, document.body
        )}
      </span>
    </div>
  )
}

// ---------- 포트 칩 ----------

function PortChip({ p, host, contextPath, tenant, onOpen }: { p: MockFleetPort; host: string; contextPath: string; tenant?: string | null; onOpen: () => void }) {
  const color = p.state === 'LISTENING' ? 'var(--fl-ok)' : p.state === 'FAILED' ? 'var(--fl-fail)' : 'var(--fl-text-muted)'
  const isHttp = p.kind === 'HTTP'
  const title = isHttp
    ? `HTTP 게이트웨이 — 앱 포트 ${p.port}${contextPath ? ` (${contextPath})` : ''} 에서 켜진 HTTP Mock ${p.count}개를 /mock/{slug}/** 로 서빙`
    : p.state === 'LISTENING' ? `TCP 리스너 열림 — ${host}:${p.port} · ${p.mockName} (클릭=행으로)` : p.state === 'FAILED' ? `켜져 있지만 리스너가 안 열림 — ${p.error ?? ''}` : `꺼짐 — ${p.mockName}`
  const Tag = isHttp ? 'div' : 'button'
  return (
    <Tag onClick={isHttp ? undefined : onOpen} title={title} aria-label={`포트 ${p.port} ${p.kind} ${p.state}`} data-state={p.state}
      style={{ ...portChip, borderStyle: p.state === 'OFF' ? 'dashed' : 'solid', cursor: isHttp ? 'default' : 'pointer', opacity: p.state === 'OFF' ? 0.75 : 1, borderColor: p.state === 'FAILED' ? 'color-mix(in srgb, var(--fl-fail) 50%, var(--fl-border))' : undefined }}>
      <span style={{ ...led, width: 8, height: 8, background: color, boxShadow: p.state === 'LISTENING' ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` : undefined }} />
      <b style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 13, color: 'var(--fl-text)' }}>:{p.port}</b>
      <span style={{ ...kindTag, color: isHttp ? 'var(--fl-cat-http)' : 'var(--fl-cat-tcp)' }}>{p.kind}</span>
      <span style={{ fontSize: 12, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
        {isHttp ? `게이트웨이 ×${p.count}` : p.mockName}
      </span>
      {!isHttp && !p.readable && <span aria-label="접근 없음" style={{ fontSize: 11 }}><AppIcon name="lock" size={11} /></span>}
      {p.state === 'FAILED' && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-fail)' }}>바인딩 실패</span>}
      {isHttp && tenant && tenant !== 'default' && <span style={{ ...meta, fontSize: 11 }}>/{tenant}</span>}
    </Tag>
  )
}

// ---------- 스타일 ----------
const mono: CSSProperties = { fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)' }
const meta: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', fontVariantNumeric: 'tabular-nums' }
const led: CSSProperties = { display: 'inline-block', width: 9, height: 9, borderRadius: 999, flexShrink: 0 }
const kindTag: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '.03em', lineHeight: 1.5, flexShrink: 0 }
const portRow: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface-2)', maxHeight: 160, overflowY: 'auto' }
const portChip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, maxWidth: '100%' }
const groupBox: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', padding: '6px 8px 8px', boxShadow: 'var(--fl-shadow)' }
// 워크스페이스가 하나뿐이면 묶음 상자 없이 표만 — 상자 안의 상자 방지
const groupBoxSolo: CSSProperties = { border: 0, padding: 0, background: 'transparent' }
const groupHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap', padding: '4px 6px 6px' }
const chev: CSSProperties = { width: 22, height: 22, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, padding: 0 }
const roleChip: CSSProperties = { fontSize: 11, fontWeight: 650, padding: '1px 7px', borderRadius: 4, border: '1px solid var(--fl-border)', whiteSpace: 'nowrap' }
const portMini: CSSProperties = { fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', fontFamily: 'var(--fl-font-mono)', fontWeight: 700 }
const ghostMini: CSSProperties = { height: 26, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 10px', borderRadius: 'var(--fl-radius-sm)', fontSize: 12, cursor: 'pointer' }
const rowGrid: CSSProperties = { display: 'grid', gridTemplateColumns: '12px minmax(260px, 1fr) 112px minmax(150px, .55fr) 95px 60px', alignItems: 'center', gap: 12 }
const headRow: CSSProperties = { padding: '2px 10px 4px', fontSize: 11, color: 'var(--fl-text-muted)', fontWeight: 600, borderBottom: '1px solid var(--fl-border)' }
const row: CSSProperties = { padding: '7px 10px', borderBottom: '1px solid color-mix(in srgb, var(--fl-border) 60%, transparent)', borderRadius: 6, minHeight: 40, transition: 'background .12s, opacity .15s' }
const routePill: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontFamily: 'var(--fl-font-mono)', padding: '2px 7px', borderRadius: 4, background: 'var(--fl-surface-2)', color: 'var(--fl-text-soft)', maxWidth: '100%' }
const badge: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: 999, background: 'var(--fl-put, #f5a623)', color: '#fff', fontSize: 11, fontWeight: 900, flexShrink: 0 }
const toolBtn: CSSProperties = { ...ui.icon, width: 28, height: 26 }
const menuBox: CSSProperties = { position: 'fixed', width: 240, maxWidth: 'calc(100vw - 16px)', maxHeight: 'min(340px, calc(100dvh - 24px))', overflowY: 'auto', boxSizing: 'border-box', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 180, display: 'grid', gap: 2, textAlign: 'left' }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 6, overflowWrap: 'anywhere' }
const menuSelect: CSSProperties = { width: '100%', padding: '5px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12 }
