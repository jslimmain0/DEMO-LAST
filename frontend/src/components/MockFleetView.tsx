import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HttpMethod, MockFleetPort, MockFleetServer, MockFleetWorkspace } from '../api/types'
import { mockBaseUrl, mocksApi } from '../api/client'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'
import { ServerIcon } from './icons'
import { MockTopology } from './MockTopology'
import { toast } from './toast'

/**
 * Mock 서버 현황(fleet) — **모든 워크스페이스**의 Mock 을 실제 서버처럼 한 화면에.
 * - 현황 스트립(서버·서빙 중·열린 포트·요청 들어오는 중·워크스페이스) → 포트 맵(HTTP 게이트웨이 + TCP 리스너, 실제 소켓 상태) →
 *   워크스페이스별 서버 타일(랙 아이콘 + LED + 주소 + 라우트/규칙·요청·버전).
 * - 내 워크스페이스(공용·내 개인·멤버인 팀)가 먼저, 나머지는 "다른 워크스페이스" 로 접혀 **읽기 전용**(VIEWER 도 읽기 전용).
 *   접근 권한이 없는 워크스페이스의 서버는 이름·종류·켜짐·포트·살아있음만 보이고(서빙 주소·포트는 전역 자원) 열리지 않는다.
 * - 5초 폴링. 켜기/끄기 스위치는 편집 권한이 있는 서버에만.
 */
export function MockFleetView({ tenant, canEditGlobal, onOpenWorkspace }: {
  tenant?: string | null
  canEditGlobal: boolean
  onOpenWorkspace: (workspaceId: string) => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const fleet = useQuery({ queryKey: ['mock-fleet'], queryFn: mocksApi.fleet, refetchInterval: 5000 })
  const [open, setOpen] = useState<Record<string, boolean>>({})
  // 타일(워크스페이스별 카드)은 맵 아래 토글 — 기본 접힘(localStorage)
  const [showTiles, setShowTilesRaw] = useState(() => { try { return localStorage.getItem('fl:mock:fleetTiles') === '1' } catch { return false } })
  const setShowTiles = (v: boolean) => { setShowTilesRaw(v); try { localStorage.setItem('fl:mock:fleetTiles', v ? '1' : '0') } catch { /* */ } }
  const toggle = useMutation({
    mutationFn: (s: MockFleetServer) => mocksApi.update(s.id, { enabled: !s.enabled }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mock-fleet'] }); qc.invalidateQueries({ queryKey: ['mock-servers'] }) },
    onError: (e) => toast(apiErrorMessage(e, '변경 실패'), 'error'),
  })
  const f = fleet.data
  const host = window.location.hostname || 'localhost'

  const byWs = useMemo(() => {
    const m = new Map<string, MockFleetServer[]>()
    for (const s of f?.servers ?? []) { const arr = m.get(s.workspaceId) ?? []; arr.push(s); m.set(s.workspaceId, arr) }
    for (const arr of m.values()) arr.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, 'ko'))
    return m
  }, [f])
  const { mine, others } = useMemo(() => {
    const all = f?.workspaces ?? []
    const rank = (w: MockFleetWorkspace) => (w.kind === 'PUBLIC' ? 0 : w.kind === 'PERSONAL' ? 1 : 2)
    const sorted = [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'))
    return {
      mine: sorted.filter((w) => w.mine),
      // 남의 워크스페이스는 서버가 있는 것만(빈 팀은 소음) — 접근 불가 워크스페이스는 이름·개수만 보인다
      others: sorted.filter((w) => !w.mine && (byWs.get(w.id)?.length ?? 0) > 0),
    }
  }, [f, byWs])
  const isOpen = (w: MockFleetWorkspace) => open[w.id] ?? w.mine

  if (fleet.isError) return <p style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 18 }}>서버 현황을 불러오지 못했습니다: {apiErrorMessage(fleet.error)}</p>
  if (!f) return <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, marginTop: 18 }}>서버 현황을 불러오는 중…</p>

  const servers = f.servers
  const stats = {
    total: servers.length,
    on: servers.filter((s) => (s.kind === 'TCP' ? s.listening : s.enabled)).length,
    ports: f.ports.filter((p) => p.state === 'LISTENING').length,
    failed: f.ports.filter((p) => p.state === 'FAILED').length,
    live: servers.filter((s) => s.recentRequests > 0).length,
    ws: mine.length + others.length,
    readOnlyWs: others.length + mine.filter((w) => w.myRole === 'VIEWER').length,
  }

  return (
    <section aria-label="서버 현황" style={{ marginTop: 18, display: 'grid', gap: 22 }}>
      {/* 현황 스트립 */}
      <div style={statsGrid}>
        {([
          ['서버', stats.total, 'var(--fl-text)', `HTTP ${servers.filter((s) => s.kind !== 'TCP').length} · TCP ${servers.filter((s) => s.kind === 'TCP').length}`],
          ['서빙 중', stats.on, 'var(--fl-ok)', `${stats.total - stats.on}개 꺼짐`],
          ['열린 포트', stats.ports, stats.failed ? 'var(--fl-fail)' : 'var(--fl-ok)', stats.failed ? `${stats.failed}개 바인딩 실패` : `HTTP :${f.httpPort} 포함`],
          ['요청 들어오는 중', stats.live, stats.live ? 'var(--fl-ok)' : 'var(--fl-text-muted)', '최근 60초'],
          ['워크스페이스', stats.ws, 'var(--fl-text)', stats.readOnlyWs ? `읽기 전용 ${stats.readOnlyWs}` : '전부 편집 가능'],
        ] as Array<[string, number, string, string]>).map(([label, n, color, sub]) => (
          <div key={label} style={statCard}>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontWeight: 600 }}>{label}</span>
            <span style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--fl-font-head)', color, lineHeight: 1.1 }}>{n}</span>
            <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{sub}</span>
          </div>
        ))}
      </div>

      {/* 토폴로지 맵 — 서버마다 컴퓨터, 네트워크 → 게이트웨이/포트 → 서버 */}
      {servers.length > 0 && (
        <div>
          <div style={sectionHead}>
            <span style={sectionLabel}>🖧 토폴로지</span>
            <span style={{ ...meta, marginLeft: 8 }}>{host} · 실제 리스너 기준 · {new Date(f.generatedAt).toLocaleTimeString()} 갱신 · 휠=이동 · Ctrl+휠=줌 · 서버 클릭=열기</span>
          </div>
          <MockTopology fleet={f} host={host} tenant={tenant} onOpen={(s) => navigate(`/mocks/${s.id}`)} onOpenWorkspace={onOpenWorkspace} />
        </div>
      )}

      {/* 포트 맵 — 실제 소켓 상태 */}
      <div>
        <div style={sectionHead}>
          <span style={sectionLabel}>🔌 포트 맵</span>
          <span style={{ ...meta, marginLeft: 8 }}>{host} · 실제 리스너 기준 · {new Date(f.generatedAt).toLocaleTimeString()} 갱신</span>
        </div>
        <div style={portRow} aria-label="포트 맵">
          {f.ports.map((p, i) => <PortChip key={`${p.port}-${p.mockId ?? 'http'}-${i}`} p={p} host={host} contextPath={f.contextPath} tenant={tenant}
            onOpen={() => { if (p.mockId && p.readable) navigate(`/mocks/${p.mockId}`); else if (p.mockId) toast('접근 권한이 없는 워크스페이스의 서버입니다 — 포트·상태만 보입니다.', 'error') }} />)}
        </div>
      </div>

      {/* 워크스페이스별 서버 */}
      {servers.length === 0 && (
        <div style={emptyBox}>
          <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 16 }}>아직 띄운 Mock 서버가 없습니다</div>
          <div style={{ color: 'var(--fl-text-muted)', fontSize: 13, marginTop: 6 }}>위의 <b>+ HTTP Mock</b> / <b>+ TCP Mock</b> 으로 만들면 여기에 실제 서버처럼 나타납니다.</div>
        </div>
      )}
      {servers.length > 0 && (
        <div>
          <button onClick={() => setShowTiles(!showTiles)} aria-expanded={showTiles} style={ghostMini} title="워크스페이스별 서버 타일(카드) 목록">{showTiles ? '▾ 워크스페이스별 타일 접기' : '▸ 워크스페이스별 타일 보기'}</button>
        </div>
      )}
      {showTiles && mine.map((w) => (
        <WorkspaceSection key={w.id} w={w} servers={byWs.get(w.id) ?? []} open={isOpen(w)} onToggleOpen={() => setOpen((o) => ({ ...o, [w.id]: !isOpen(w) }))}
          host={host} tenant={tenant} canEditGlobal={canEditGlobal} onOpenWorkspace={onOpenWorkspace} onToggle={(s) => toggle.mutate(s)} toggling={toggle.isPending} />
      ))}
      {showTiles && others.length > 0 && (
        <div>
          <div style={{ ...sectionHead, marginTop: 4 }}>
            <span style={sectionLabel}>🔒 다른 워크스페이스</span>
            <span style={{ ...meta, marginLeft: 8 }}>내 소속이 아닌 워크스페이스 — 읽기 전용. 접근 권한이 없으면 이름·포트·상태만 보입니다.</span>
          </div>
          <div style={{ display: 'grid', gap: 14 }}>
            {others.map((w) => (
              <WorkspaceSection key={w.id} w={w} servers={byWs.get(w.id) ?? []} open={isOpen(w)} onToggleOpen={() => setOpen((o) => ({ ...o, [w.id]: !isOpen(w) }))}
                host={host} tenant={tenant} canEditGlobal={canEditGlobal} onOpenWorkspace={onOpenWorkspace} onToggle={(s) => toggle.mutate(s)} toggling={toggle.isPending} other />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------- 포트 칩 ----------

function PortChip({ p, host, contextPath, tenant, onOpen }: { p: MockFleetPort; host: string; contextPath: string; tenant?: string | null; onOpen: () => void }) {
  const color = p.state === 'LISTENING' ? 'var(--fl-ok)' : p.state === 'FAILED' ? 'var(--fl-fail)' : 'var(--fl-text-muted)'
  const isHttp = p.kind === 'HTTP'
  const title = isHttp
    ? `HTTP 게이트웨이 — 앱 포트 ${p.port}${contextPath ? ` (${contextPath})` : ''} 에서 켜진 HTTP Mock ${p.count}개를 /mock/{slug}/** 로 서빙`
    : p.state === 'LISTENING' ? `TCP 리스너 열림 — ${host}:${p.port} · ${p.mockName}` : p.state === 'FAILED' ? `켜져 있지만 리스너가 안 열림 — ${p.error ?? ''}` : `꺼짐 — ${p.mockName}`
  const Tag = isHttp ? 'div' : 'button'
  return (
    <Tag onClick={isHttp ? undefined : onOpen} title={title} aria-label={`포트 ${p.port} ${p.kind} ${p.state}`} data-state={p.state}
      style={{ ...portChip, borderStyle: p.state === 'OFF' ? 'dashed' : 'solid', cursor: isHttp ? 'default' : p.readable ? 'pointer' : 'not-allowed', opacity: p.state === 'OFF' ? 0.75 : 1, borderColor: p.state === 'FAILED' ? 'color-mix(in srgb, var(--fl-fail) 50%, var(--fl-border))' : undefined }}>
      <span className={p.state === 'LISTENING' && isHttp ? undefined : undefined} style={{ ...led, background: color, boxShadow: p.state === 'LISTENING' ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` : undefined }} />
      <b style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 13, color: 'var(--fl-text)' }}>:{p.port}</b>
      <span style={{ ...kindTag, color: isHttp ? 'var(--fl-cat-http, var(--fl-primary))' : 'var(--fl-cat-tcp, #7c5cff)' }}>{p.kind}</span>
      <span style={{ fontSize: 12, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
        {isHttp ? `게이트웨이 · ${p.count}개 서빙` : p.mockName}
      </span>
      {!isHttp && !p.readable && <span aria-label="접근 없음" style={{ fontSize: 11 }}>🔒</span>}
      {p.state === 'FAILED' && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fl-fail)' }}>바인딩 실패</span>}
      {isHttp && tenant && tenant !== 'default' && <span style={{ ...meta, fontSize: 10.5 }}>/{tenant}</span>}
    </Tag>
  )
}

// ---------- 워크스페이스 섹션 ----------

function WorkspaceSection({ w, servers, open, onToggleOpen, host, tenant, canEditGlobal, onOpenWorkspace, onToggle, toggling, other }: {
  w: MockFleetWorkspace; servers: MockFleetServer[]; open: boolean; onToggleOpen: () => void
  host: string; tenant?: string | null; canEditGlobal: boolean; onOpenWorkspace: (id: string) => void
  onToggle: (s: MockFleetServer) => void; toggling: boolean; other?: boolean
}) {
  const icon = w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'
  const readable = w.myRole != null
  const readOnly = !readable || w.myRole === 'VIEWER' || !canEditGlobal
  const on = servers.filter((s) => (s.kind === 'TCP' ? s.listening : s.enabled)).length
  const live = servers.filter((s) => s.recentRequests > 0).length
  const ports = servers.filter((s) => s.tcpPort != null).map((s) => s.tcpPort as number).sort((a, b) => a - b)
  const roleLabel = !readable ? '접근 없음' : w.myRole === 'VIEWER' ? '읽기 전용' : w.myRole === 'OWNER' ? (w.mine ? '소유' : '관리자') : '편집'
  const roleColor = !readable ? 'var(--fl-fail)' : w.myRole === 'VIEWER' ? 'var(--fl-put, #f5a623)' : 'var(--fl-ok)'
  return (
    <section aria-label={`워크스페이스 ${w.name}`} data-mine={w.mine} style={{ ...wsBox, opacity: other && !open ? 0.85 : 1 }}>
      <div style={wsHead}>
        <button onClick={onToggleOpen} aria-expanded={open} style={chev} title={open ? '접기' : '펼치기'}>{open ? '▾' : '▸'}</button>
        <span aria-hidden style={{ fontSize: 15 }}>{icon}</span>
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 15, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{w.name}</span>
        <span style={{ ...roleChip, color: roleColor, borderColor: `color-mix(in srgb, ${roleColor} 40%, var(--fl-border))` }} title={!readable ? '이 워크스페이스의 멤버가 아닙니다 — 서버 이름·포트·상태만 보입니다' : w.myRole === 'VIEWER' ? 'viewer 롤 — 열람만' : `${w.myRole} 롤`}>
          {(!readable || w.myRole === 'VIEWER') && '🔒 '}{roleLabel}
        </span>
        <span style={{ ...meta, marginLeft: 6 }}>서버 {servers.length} · 서빙 {on}{live ? ` · 요청 중 ${live}` : ''}</span>
        {ports.length > 0 && <span style={{ ...meta, display: 'inline-flex', gap: 4, alignItems: 'center' }}>{ports.map((p) => <span key={p} style={portMini}>:{p}</span>)}</span>}
        {readable && <button onClick={() => onOpenWorkspace(w.id)} style={{ ...ghostMini, marginLeft: 'auto' }} title="이 워크스페이스로 전환해 목록 보기">목록으로 →</button>}
      </div>
      {open && (
        servers.length === 0
          ? <p style={{ ...meta, margin: '6px 0 0 30px' }}>이 워크스페이스에는 아직 Mock 서버가 없습니다.</p>
          : <div style={tileGrid}>
              {servers.map((s) => <ServerTile key={s.id} s={s} host={host} tenant={tenant} canToggle={!readOnly && s.readable && s.myRole !== 'VIEWER'} onToggle={() => onToggle(s)} toggling={toggling} />)}
            </div>
      )}
    </section>
  )
}

// ---------- 서버 타일 ----------

function ServerTile({ s, host, tenant, canToggle, onToggle, toggling }: { s: MockFleetServer; host: string; tenant?: string | null; canToggle: boolean; onToggle: () => void; toggling: boolean }) {
  const navigate = useNavigate()
  const isTcp = s.kind === 'TCP'
  const state: 'on' | 'off' | 'fail' = isTcp ? (s.listening ? 'on' : s.listenError ? 'fail' : 'off') : (s.enabled ? 'on' : 'off')
  const live = s.recentRequests > 0
  const ledColor = state === 'on' ? 'var(--fl-ok)' : state === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, var(--fl-border))'
  const kindColor = isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-http, var(--fl-primary))'
  const base = isTcp ? '' : mockBaseUrl(s.slug, tenant)
  const address = isTcp ? `${host}:${s.tcpPort ?? '?'}` : base.replace(/^https?:\/\//, '')
  const stateLabel = isTcp ? (state === 'on' ? '리스닝' : state === 'fail' ? '바인딩 실패' : '꺼짐') : (state === 'on' ? '서빙 중' : '꺼짐')
  const openable = s.readable
  const readOnly = !s.readable || s.myRole === 'VIEWER'
  const labels = s.routeLabels
  const openIt = () => { if (openable) navigate(`/mocks/${s.id}`) }
  return (
    <div className="fl-server-tile" role={openable ? 'button' : undefined} tabIndex={openable ? 0 : -1} onClick={openIt} data-state={state} data-readable={s.readable}
      onKeyDown={(e) => { if (openable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openIt() } }}
      title={!s.readable ? '접근 권한이 없는 워크스페이스 — 이름·포트·상태만 보입니다' : readOnly ? '읽기 전용 — 열어서 볼 수 있습니다' : undefined}
      style={{ ...tile, cursor: openable ? 'pointer' : 'not-allowed', opacity: state === 'off' ? 0.78 : 1, borderTop: `3px solid ${state === 'fail' ? 'var(--fl-fail)' : state === 'on' ? kindColor : 'var(--fl-border)'}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ ...rack, color: kindColor, background: `color-mix(in srgb, ${kindColor} 12%, var(--fl-surface))` }} aria-hidden>
          <ServerIcon size={20} />
          <span className={live ? 'fl-led-live' : undefined} style={{ ...led, position: 'absolute', right: -3, bottom: -3, width: 10, height: 10, background: ledColor, border: '2px solid var(--fl-surface)' }} />
        </span>
        <span style={{ minWidth: 0, flex: 1, display: 'grid', gap: 2 }}>
          <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 14, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
          <span style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ ...kindTag, color: kindColor }}>{isTcp ? 'TCP' : 'HTTP'}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: ledColor === 'var(--fl-border-strong, var(--fl-border))' ? 'var(--fl-text-muted)' : ledColor }} aria-label={`상태 ${stateLabel}`}>{stateLabel}</span>
            {live && <span style={{ ...meta, fontSize: 10.5, color: 'var(--fl-ok)' }} title="최근 60초 요청 수">● {s.recentRequests}건/60초</span>}
            {s.unmatchedRequests > 0 && <span style={{ ...meta, fontSize: 10.5, color: 'var(--fl-fail)', fontWeight: 700 }} title="규칙에 안 맞은 요청">무매칭 {s.unmatchedRequests}</span>}
          </span>
        </span>
        {canToggle && <Switch on={s.enabled} disabled={toggling} label={`${s.name} ${s.enabled ? '끄기' : '켜기'}`} onChange={onToggle} />}
        {readOnly && <span style={{ ...lockChip }} title={!s.readable ? '접근 권한 없음' : '읽기 전용'}>🔒</span>}
      </div>
      {/* 주소 */}
      {isTcp ? (
        <span style={{ ...meta, fontFamily: 'var(--fl-font-mono)', fontSize: 12, color: 'var(--fl-text)' }} title="워크플로 TCP 노드 대상(host:port)">🔌 {address}{s.tcpEnabled === false ? <span style={{ color: 'var(--fl-text-muted)' }}> · 리스너 꺼짐</span> : null}</span>
      ) : (
        <button onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(base).then(() => toast('base URL 복사됨', 'ok')).catch(() => {}) }} title={`${base} — 클릭해 복사`}
          style={{ ...meta, fontFamily: 'var(--fl-font-mono)', fontSize: 12, color: 'var(--fl-text)', border: 'none', background: 'transparent', padding: 0, cursor: 'copy', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', justifySelf: 'start' }}>
          🌐 {address} <span aria-hidden style={{ color: 'var(--fl-primary)' }}>⧉</span>
        </button>
      )}
      {/* 구성 요약 */}
      {s.readable ? (
        isTcp ? (
          <span style={meta}>요청 필드 {s.tcpFieldCount} · 규칙 {s.tcpRuleCount}{s.hasCodec ? ' · ◈ 코덱' : ''}{s.environment ? ` · 🔑 ${s.environment}` : ''}</span>
        ) : labels.length > 0 ? (
          <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} aria-label="라우트">
            {labels.slice(0, 4).map((l, i) => {
              const sp = l.indexOf(' '); const m = sp > 0 ? l.slice(0, sp) : 'ANY'; const p = sp > 0 ? l.slice(sp + 1) : l
              return <span key={i} style={routePill} title={l}><b style={{ color: METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-text-muted)', fontSize: 9.5 }}>{m}</b><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>{p}</span></span>
            })}
            {s.routeCount > 4 && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }}>+{s.routeCount - 4}</span>}
            {s.hasCodec && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }}>◈</span>}
          </span>
        ) : <span style={meta}>라우트 없음</span>
      ) : (
        <span style={meta}>{isTcp ? `규칙 ${s.tcpRuleCount}` : `라우트 ${s.routeCount}`} · 정의는 비공개</span>
      )}
      {/* 푸터 */}
      <span style={{ ...meta, display: 'flex', gap: 8, alignItems: 'center' }}>
        <span title={s.lastRequestAt ? new Date(s.lastRequestAt).toLocaleString() : undefined}>{s.lastRequestAt ? `요청 ${relTime(s.lastRequestAt)}` : '요청 없음'}</span>
        <span style={{ marginLeft: 'auto' }}>{s.currentVersion > 0 ? `v${s.currentVersion}` : ''}{s.updatedAt ? ` · ${relTime(s.updatedAt)}` : ''}</span>
      </span>
    </div>
  )
}

/** 켜기/끄기 스위치 — n8n 식 Active 토글(role=switch). */
function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: () => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={(e) => { e.stopPropagation(); onChange() }} title={label}
      style={{ ...switchTrack, background: on ? 'var(--fl-ok)' : 'var(--fl-border-strong, var(--fl-border))', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ ...switchKnob, transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
    </button>
  )
}

// ---------- 스타일 ----------
const meta: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const statsGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }
const statCard: CSSProperties = { display: 'grid', gap: 3, padding: '12px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow)' }
const sectionHead: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 8, flexWrap: 'wrap' }
const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--fl-text)' }
const portRow: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface-2)' }
const portChip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, maxWidth: '100%' }
const led: CSSProperties = { display: 'inline-block', width: 8, height: 8, borderRadius: 999, flexShrink: 0 }
const kindTag: CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: '.04em', padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', lineHeight: 1.5 }
const wsBox: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', padding: '10px 14px 12px', boxShadow: 'var(--fl-shadow)' }
const wsHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap' }
const chev: CSSProperties = { width: 22, height: 22, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, padding: 0 }
const roleChip: CSSProperties = { fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', whiteSpace: 'nowrap' }
const portMini: CSSProperties = { fontSize: 10.5, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', fontFamily: 'var(--fl-font-mono)' }
const ghostMini: CSSProperties = { height: 28, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 10px', borderRadius: 'var(--fl-radius-sm)', fontSize: 12, cursor: 'pointer' }
const tileGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))', gap: 10, marginTop: 12 }
const tile: CSSProperties = { display: 'grid', gap: 8, padding: '12px 14px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', minWidth: 0, boxShadow: 'var(--fl-shadow)' }
const rack: CSSProperties = { position: 'relative', width: 36, height: 36, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }
const routePill: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontFamily: 'var(--fl-font-mono)', padding: '1px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', maxWidth: '100%' }
const lockChip: CSSProperties = { fontSize: 12, flexShrink: 0 }
const switchTrack: CSSProperties = { position: 'relative', width: 34, height: 18, borderRadius: 999, border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0, transition: 'background .15s' }
const switchKnob: CSSProperties = { position: 'absolute', top: 2, left: 2, width: 14, height: 14, borderRadius: 999, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.35)', transition: 'transform .15s' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: '36px 30px', textAlign: 'center', color: 'var(--fl-text-muted)' }
