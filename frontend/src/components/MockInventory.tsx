import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HttpMethod, MockFleet, MockFleetPort, MockFleetServer, MockFleetWorkspace } from '../api/types'
import { mockBaseUrl } from '../api/client'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { relTime } from '../lib/format'
import { toast } from './toast'

export type ServerAction = 'toggle' | 'rename' | 'duplicate' | 'export' | 'delete' | 'fav' | 'copyUrl' | 'move' | 'goFlow'
export type FleetFilter = 'all' | 'on' | 'off' | 'live' | 'unmatched' | 'fav'
export type ServerState = 'on' | 'off' | 'fail'
export function serverState(s: MockFleetServer): ServerState {
  return s.kind === 'TCP' ? (s.listening ? 'on' : s.listenError ? 'fail' : 'off') : (s.enabled ? 'on' : 'off')
}
const kindColorOf = (isTcp: boolean) => (isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-http, var(--fl-primary))')

/**
 * Mock 서버 인벤토리 — Mock 화면의 유일한 보기. Docker Desktop/Mockoon 식 **행 목록**을 워크스페이스로 묶는다(에이전트 토론 결론: 그래프 폐기).
 * - 상단 **포트 스트립**: 실제 리스너 기준 칩(● 리스닝 / ✕ 바인딩 실패, 꺼짐은 `+N 꺼짐` 으로 접음). 칩 클릭 = 그 행으로 스크롤+하이라이트.
 * - **워크스페이스 그룹**: 내 소속(공용·내 개인·멤버인 팀) 먼저 펼침, 남의 것은 접힘 + 🔒(읽기 전용/접근 없음). 헤더에 롤·서버/서빙 수·포트·**+ Mock**.
 *   검색/필터 중엔 안 맞는 행을 숨기고(`N/M`) 일치가 있는 그룹은 자동으로 펼친다. 접힘은 localStorage.
 * - **행** = 한 서버: LED(◉ 요청 중 펄스 · ● 서빙/리스닝 · ✕ 실패 · ○ 꺼짐) → **포트(가장 큰 글자)** + 경로/호스트 → 이름 → 종류·상태 → 구성(라우트 필 / 필드·규칙) → 트래픽(60초·마지막 요청·무매칭) → ↗ 워크플로 → vN → ⏻ ⋯(항상 표시).
 *   꺼짐=흐림·점선, 접근 불가=이름·포트·상태만. 클릭=편집기, Ctrl/Shift+클릭 또는 선택 모드=선택.
 */
export function MockInventory({ fleet, host, tenant, match, selected, selectMode, favs, canEditGlobal, wsOptions, onOpen, onToggleSelect, onAction, onCreateIn }: {
  fleet: MockFleet
  host: string
  tenant?: string | null
  match: ((s: MockFleetServer) => boolean) | null   // null = 전부 표시
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

  const groups = useMemo(() => {
    const byWs = new Map<string, MockFleetServer[]>()
    for (const s of fleet.servers) { const a = byWs.get(s.workspaceId) ?? []; a.push(s); byWs.set(s.workspaceId, a) }
    // 켜진 것 → HTTP 먼저 → 포트 → 이름
    for (const a of byWs.values()) a.sort((x, y) => Number(serverState(y) === 'on') - Number(serverState(x) === 'on') || (x.kind === 'TCP' ? 1 : 0) - (y.kind === 'TCP' ? 1 : 0) || (x.tcpPort ?? 0) - (y.tcpPort ?? 0) || x.name.localeCompare(y.name, 'ko'))
    const rank = (w: MockFleetWorkspace) => (w.kind === 'PUBLIC' ? 0 : w.kind === 'PERSONAL' ? 1 : 2)
    return [...fleet.workspaces]
      .sort((a, b) => Number(b.mine) - Number(a.mine) || rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'))
      .filter((w) => w.mine || (byWs.get(w.id)?.length ?? 0) > 0)
      .map((w) => { const all = byWs.get(w.id) ?? []; return { ws: w, all, shown: match ? all.filter(match) : all } })
  }, [fleet, match])
  const searching = match != null

  const focusRow = (id: string) => {
    const el = document.getElementById(`mock-row-${id}`)
    if (!el) { toast('검색/필터에 가려 있거나 접힌 그룹에 있습니다.', 'error'); return }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlash(id); setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600)
  }

  const ports = fleet.ports
  const offPorts = ports.filter((p) => p.kind === 'TCP' && p.state === 'OFF')
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* 포트 스트립 — 실제 리스너 기준 */}
      <div style={portRow} aria-label="포트 맵">
        <span style={{ ...meta, fontWeight: 700, color: 'var(--fl-text)', marginRight: 2 }}>포트</span>
        {ports.filter((p) => p.kind === 'HTTP' || p.state !== 'OFF').map((p, i) => (
          <PortChip key={`${p.port}-${p.mockId ?? 'http'}-${i}`} p={p} host={host} contextPath={fleet.contextPath} tenant={tenant} onOpen={() => { if (p.mockId) focusRow(p.mockId) }} />
        ))}
        {offPorts.length > 0 && (
          <button onClick={() => setShowOff((v) => !v)} aria-expanded={showOff} style={{ ...portChip, borderStyle: 'dashed', opacity: 0.8, cursor: 'pointer' }} title="꺼진 TCP Mock 의 포트(리스너 닫힘)">
            {showOff ? '▾' : '▸'} 꺼짐 {offPorts.length}
          </button>
        )}
        {showOff && offPorts.map((p, i) => <PortChip key={`off-${p.port}-${i}`} p={p} host={host} contextPath={fleet.contextPath} tenant={tenant} onOpen={() => { if (p.mockId) focusRow(p.mockId) }} />)}
      </div>

      {/* 워크스페이스 그룹 */}
      {groups.map(({ ws: w, all, shown }) => {
        const readable = w.myRole != null
        const writable = canEditGlobal && (w.myRole === 'OWNER' || w.myRole === 'EDITOR')
        const isCollapsed = searching ? shown.length === 0 : (collapsed[w.id] ?? !w.mine)
        const on = all.filter((s) => serverState(s) === 'on').length
        const live = all.filter((s) => s.recentRequests > 0).length
        const tcpPorts = all.filter((s) => s.tcpPort != null).sort((a, b) => (a.tcpPort ?? 0) - (b.tcpPort ?? 0))
        const icon = w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'
        const roleLabel = !readable ? '접근 없음' : w.myRole === 'VIEWER' ? '읽기 전용' : w.myRole === 'OWNER' ? (w.mine ? '소유' : '관리자') : '편집'
        const roleColor = !readable ? 'var(--fl-fail)' : w.myRole === 'VIEWER' ? 'var(--fl-put, #f5a623)' : 'var(--fl-ok)'
        return (
          <section key={w.id} aria-label={`워크스페이스 ${w.name}`} data-mine={w.mine} style={{ ...groupBox, borderStyle: w.mine ? 'solid' : 'dashed' }}>
            <div style={groupHead}>
              <button onClick={() => toggleGroup(w.id, w.mine)} aria-expanded={!isCollapsed} style={chev} title={isCollapsed ? '펼치기' : '접기'}>{isCollapsed ? '▸' : '▾'}</button>
              <span aria-hidden>{icon}</span>
              <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 800, fontSize: 14.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
              <span style={{ ...roleChip, color: roleColor, borderColor: `color-mix(in srgb, ${roleColor} 40%, var(--fl-border))` }}>{(!readable || w.myRole === 'VIEWER') && '🔒 '}{roleLabel}</span>
              <span style={meta}>서버 {searching ? `${shown.length}/${all.length}` : all.length} · 서빙 {on}{live ? ` · 요청 중 ${live}` : ''}</span>
              {tcpPorts.length > 0 && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>{tcpPorts.slice(0, 6).map((s) => <span key={s.id} style={{ ...portMini, color: serverState(s) === 'on' ? 'var(--fl-ok)' : serverState(s) === 'fail' ? 'var(--fl-fail)' : 'var(--fl-text-muted)' }}>:{s.tcpPort}</span>)}{tcpPorts.length > 6 && <span style={portMini}>+{tcpPorts.length - 6}</span>}</span>}
              {writable && <button onClick={() => onCreateIn(w.id)} style={{ ...ghostMini, marginLeft: 'auto' }} title="이 워크스페이스에 새 Mock 만들기">+ Mock</button>}
            </div>
            {!isCollapsed && (
              all.length === 0
                ? <p style={{ ...meta, margin: '4px 0 6px 30px' }}>이 워크스페이스에는 아직 Mock 서버가 없습니다.</p>
                : <div style={{ overflowX: 'auto' }}>
                    <div style={{ minWidth: 1000 }}>
                      <div style={{ ...rowGrid, ...headRow }} aria-hidden>
                        <span />{selectMode && <span />}<span>포트 · 주소</span><span>이름</span><span>종류 · 상태</span><span>구성</span><span>트래픽</span><span style={{ textAlign: 'center' }}>↗</span><span>버전</span><span />
                      </div>
                      {shown.map((s) => (
                        <InventoryRow key={s.id} s={s} host={host} tenant={tenant} httpPort={fleet.httpPort} contextPath={fleet.contextPath}
                          selected={selected.has(s.id)} selectMode={selectMode} fav={favs.has(s.id)} editable={canEditGlobal && s.readable && s.myRole !== 'VIEWER'} wsOptions={wsOptions}
                          flash={flash === s.id} onOpen={onOpen} onToggleSelect={onToggleSelect} onAction={onAction} />
                      ))}
                    </div>
                  </div>
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
  const [menu, setMenu] = useState(false)
  const [flows, setFlows] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) { setMenu(false); setFlows(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); setFlows(false) } }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true) }
  }, [menu])
  const st = serverState(s)
  const isTcp = s.kind === 'TCP'
  const live = s.recentRequests > 0
  const kindColor = kindColorOf(isTcp)
  const ledColor = st === 'on' ? 'var(--fl-ok)' : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, #9aa0b2)'
  const readOnly = !s.readable || s.myRole === 'VIEWER'
  const seg = tenant && tenant !== 'default' ? `${tenant}/${s.slug}` : s.slug
  const port = isTcp ? (s.tcpPort != null ? `:${s.tcpPort}` : ':—') : `:${httpPort}`
  const tail = isTcp ? host : `${contextPath}/mock/${seg}`
  const stateLabel = isTcp ? (st === 'on' ? '리스닝' : st === 'fail' ? '바인딩 실패' : '꺼짐') : (st === 'on' ? '서빙 중' : '꺼짐')
  const usedBy = s.usedBy ?? []
  const act = (action: ServerAction, arg?: string) => { setMenu(false); setFlows(false); onAction(s, action, arg) }
  const click = (e: React.MouseEvent) => { if (selectMode || e.ctrlKey || e.metaKey || e.shiftKey) onToggleSelect(s); else if (s.readable) onOpen(s) }
  const labels = s.routeLabels
  return (
    <div id={`mock-row-${s.id}`} className={`fl-mock-row${flash ? ' fl-row-flash' : ''}`} role={s.readable || selectMode ? 'button' : undefined} tabIndex={s.readable ? 0 : -1}
      data-state={st} data-kind={isTcp ? 'TCP' : 'HTTP'} data-readable={s.readable} data-selected={selected ? 'true' : undefined}
      onClick={click} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); if (s.readable) onOpen(s) } }}
      title={!s.readable ? '접근 권한이 없는 워크스페이스 — 이름·포트·상태만 보입니다' : undefined}
      style={{ ...rowGrid, ...row, borderLeft: `3px solid ${st === 'on' ? kindColor : st === 'fail' ? 'var(--fl-fail)' : 'transparent'}`, opacity: st === 'off' ? 0.6 : 1, cursor: s.readable || selectMode ? 'pointer' : 'not-allowed', boxShadow: selected ? 'inset 0 0 0 2px var(--fl-primary)' : undefined, background: selected ? 'color-mix(in srgb, var(--fl-primary) 7%, var(--fl-surface))' : undefined }}>
      {selectMode && <input type="checkbox" checked={selected} readOnly aria-label={`${s.name} 선택`} style={{ width: 14, height: 14, accentColor: 'var(--fl-primary)', margin: 0, pointerEvents: 'none' }} />}
      <span className={live ? 'fl-led-live' : undefined} style={{ ...led, background: ledColor }} aria-label={`상태 ${stateLabel}${live ? ' · 요청 중' : ''}`} />
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <b className="fl-port" style={{ ...mono, fontSize: 15, fontWeight: 800, color: st === 'off' ? 'var(--fl-text-muted)' : kindColor, flexShrink: 0 }}>{port}</b>
        <span style={{ ...mono, fontSize: 11.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={isTcp ? `${host}${port}` : mockBaseUrl(s.slug, tenant)}>{tail}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        {fav && <span aria-label="즐겨찾기" style={{ color: 'var(--fl-put, #f5a623)', fontSize: 12 }}>★</span>}
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 13.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
        <span style={{ ...kindTag, color: kindColor }}>{isTcp ? 'TCP' : 'HTTP'}</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: st === 'off' ? 'var(--fl-text-muted)' : ledColor }} title={s.listenError ?? undefined}>{stateLabel}</span>
        {st === 'fail' && <span style={{ ...badge, background: 'var(--fl-fail)' }} title={s.listenError ?? '바인딩 실패'}>!</span>}
        {readOnly && <span style={{ fontSize: 11 }} title={!s.readable ? '접근 권한 없음' : '읽기 전용'}>🔒</span>}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, overflow: 'hidden' }} aria-label={!isTcp && s.readable ? '라우트' : undefined}>
        {!s.readable ? <span style={meta}>{isTcp ? `규칙 ${s.tcpRuleCount}` : `라우트 ${s.routeCount}`} · 정의 비공개</span>
          : isTcp ? <span style={{ ...meta, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`프로토콜 ${s.protocolName ?? '없음'} · 규칙 ${s.tcpRuleCount}${s.upstream ? ` · proxy→${s.upstream}` : ''}${s.environment ? ` · 시크릿 환경 ${s.environment}` : ''}`}>{s.protocolName ?? '프로토콜 없음'} · 규칙 {s.tcpRuleCount}{s.upstream ? ` · proxy→${s.upstream}` : ''}{s.environment ? ` · 🔑${s.environment}` : ''}</span>
          : labels.length > 0 ? <>
              {labels.slice(0, 3).map((l, i) => { const sp = l.indexOf(' '); const m = sp > 0 ? l.slice(0, sp) : 'ANY'; const p = sp > 0 ? l.slice(sp + 1) : l; return <span key={i} style={routePill} title={l}><b style={{ color: METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-text-muted)', fontSize: 9.5 }}>{m}</b><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{p}</span></span> })}
              {s.routeCount > 3 && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }}>+{s.routeCount - 3}</span>}
              {s.hasCodec && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }} title="코덱">◈</span>}
              {s.environment && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }} title="시크릿 환경">🔑{s.environment}</span>}
            </>
          : <span style={meta}>라우트 없음</span>}
      </span>
      <span style={{ ...meta, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {live && <span style={{ color: 'var(--fl-ok)', fontWeight: 700 }}>● {s.recentRequests}건/60초 · </span>}
        {s.lastRequestAt ? relTime(s.lastRequestAt) : '요청 없음'}
        {s.unmatchedRequests > 0 && <span style={{ color: 'var(--fl-fail)', fontWeight: 700 }} title="규칙에 안 맞은 요청"> · 무매칭 {s.unmatchedRequests}</span>}
      </span>
      <span style={{ textAlign: 'center' }}>
        {usedBy.length > 0
          ? <span style={{ ...meta, color: 'var(--fl-primary)', fontWeight: 700 }} title={`이 Mock 을 쓰는 워크플로: ${usedBy.map((f) => f.name).join(', ')}`}>↗{usedBy.length}</span>
          : <span style={{ ...meta, opacity: 0.4 }} title="사용하는 워크플로 없음">—</span>}
      </span>
      <span style={meta} title={s.updatedAt ? `수정 ${new Date(s.updatedAt).toLocaleString()}` : undefined}>{s.currentVersion > 0 ? `v${s.currentVersion}` : ''}</span>
      <span ref={menuRef} className="fl-mock-tools" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} style={{ position: 'relative', display: 'flex', gap: 2, justifyContent: 'flex-end' }}>
        {editable && <button onClick={() => act('toggle')} aria-label={`${s.name} ${s.enabled ? '끄기' : '켜기'}`} title={s.enabled ? '끄기' : '켜기'} style={{ ...toolBtn, color: s.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)' }}>⏻</button>}
        {s.readable && <button onClick={() => setMenu((v) => !v)} aria-label={`${s.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu} title="작업" style={toolBtn}>⋯</button>}
        {menu && (
          <div role="menu" style={menuBox}>
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
                <select aria-label="워크스페이스 이동" value={s.workspaceId} onChange={(e) => act('move', e.target.value)} style={menuSelect}>
                  {wsOptions.map((w) => <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>)}
                </select>
              </>
            )}
            {editable && <button role="menuitem" style={{ ...menuItem, color: 'var(--fl-fail)' }} onClick={() => act('delete')}>🗑 삭제</button>}
            <button role="menuitem" style={menuItem} onClick={() => { setMenu(false); onToggleSelect(s) }}>{selected ? '☐ 선택 해제' : '☑ 선택'}</button>
          </div>
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
      <b style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12.5, color: 'var(--fl-text)' }}>:{p.port}</b>
      <span style={{ ...kindTag, color: isHttp ? 'var(--fl-cat-http, var(--fl-primary))' : 'var(--fl-cat-tcp, #7c5cff)' }}>{p.kind}</span>
      <span style={{ fontSize: 11.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
        {isHttp ? `게이트웨이 ×${p.count}` : p.mockName}
      </span>
      {!isHttp && !p.readable && <span aria-label="접근 없음" style={{ fontSize: 10.5 }}>🔒</span>}
      {p.state === 'FAILED' && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fl-fail)' }}>바인딩 실패</span>}
      {isHttp && tenant && tenant !== 'default' && <span style={{ ...meta, fontSize: 10.5 }}>/{tenant}</span>}
    </Tag>
  )
}

// ---------- 스타일 ----------
const mono: CSSProperties = { fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)' }
const meta: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const led: CSSProperties = { display: 'inline-block', width: 9, height: 9, borderRadius: 999, flexShrink: 0 }
const kindTag: CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', lineHeight: 1.5, flexShrink: 0 }
const portRow: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface-2)' }
const portChip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, maxWidth: '100%' }
const groupBox: CSSProperties = { border: '1px solid color-mix(in srgb, var(--fl-primary) 30%, var(--fl-border))', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', padding: '6px 8px 8px', boxShadow: 'var(--fl-shadow)' }
const groupHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap', padding: '4px 6px 6px' }
const chev: CSSProperties = { width: 22, height: 22, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, padding: 0 }
const roleChip: CSSProperties = { fontSize: 10.5, fontWeight: 700, padding: '1px 8px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', whiteSpace: 'nowrap' }
const portMini: CSSProperties = { fontSize: 10.5, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', fontFamily: 'var(--fl-font-mono)', fontWeight: 700 }
const ghostMini: CSSProperties = { height: 26, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 10px', borderRadius: 'var(--fl-radius-sm)', fontSize: 12, cursor: 'pointer' }
const rowGrid: CSSProperties = { display: 'grid', gridTemplateColumns: '14px minmax(200px, 230px) minmax(120px, 1fr) 122px minmax(160px, 1.2fr) 210px 34px 40px 66px', alignItems: 'center', gap: 10 }
const headRow: CSSProperties = { padding: '2px 10px 4px', fontSize: 10.5, color: 'var(--fl-text-muted)', fontWeight: 600, borderBottom: '1px solid var(--fl-border)' }
const row: CSSProperties = { padding: '7px 10px', borderBottom: '1px solid color-mix(in srgb, var(--fl-border) 60%, transparent)', borderRadius: 6, minHeight: 40, transition: 'background .12s, opacity .15s' }
const routePill: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontFamily: 'var(--fl-font-mono)', padding: '1px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', maxWidth: '100%' }
const badge: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: 999, background: 'var(--fl-put, #f5a623)', color: '#fff', fontSize: 9.5, fontWeight: 900, flexShrink: 0 }
const toolBtn: CSSProperties = { width: 28, height: 26, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, borderRadius: 6, padding: 0 }
const menuBox: CSSProperties = { position: 'absolute', top: 30, right: 0, width: 200, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 60, display: 'grid', gap: 2, textAlign: 'left' }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const menuSelect: CSSProperties = { width: '100%', padding: '5px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12 }
