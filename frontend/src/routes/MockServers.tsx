import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MockFleetServer, MockServerDetail } from '../api/types'
import { mockBaseUrl, mocksApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { MockExportDialog, MockImportDialog } from '../components/MockTransferDialog'
import { MockInventory, serverState } from '../components/MockInventory'
import type { FleetFilter, ServerAction } from '../components/MockInventory'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'

type Kind = 'HTTP' | 'TCP'

/**
 * Mock 서버 화면 = **서버 인벤토리 하나**(카드/그래프 없음). 모든 워크스페이스의 Mock 을 실제 서버처럼 —
 * 현황 스트립(클릭=필터) · 검색/필터/선택 · 만들기(대상 워크스페이스 선택) · 가져오기 · [MockInventory](../components/MockInventory.tsx)
 * (상단 포트 스트립 + 워크스페이스 그룹(내 것 먼저, 남의 것 접힘·🔒) + 서버 행(LED·포트·주소·이름·상태·구성·트래픽·↗·vN·⏻·⋯ —
 * 켜기/끄기·이름·복제·내보내기·이동·삭제·즐겨찾기·URL 복사·↗ 워크플로, Ctrl+클릭/선택 모드로 일괄 작업)).
 * 5초 폴링(살아있음·리스너 상태). 편집은 행 클릭 → 편집기.
 */
export function MockServers() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { canEdit: canEditGlobal } = usePermissions()
  const { me } = useAuth()
  const fleet = useQuery({ queryKey: ['mock-fleet'], queryFn: mocksApi.fleet, refetchInterval: 5000 })
  const f = fleet.data
  const servers = useMemo(() => f?.servers ?? [], [f])
  const host = window.location.hostname || 'localhost'
  const wsWritable = useMemo(() => (f?.workspaces ?? []).filter((w) => w.myRole === 'OWNER' || w.myRole === 'EDITOR'), [f])
  const wsName = (id: string) => f?.workspaces.find((w) => w.id === id)?.name ?? '공용'

  // 만들기/가져오기 대상 워크스페이스 — 대시보드와 같은 마지막 선택(fl:workspace) 기억
  const [createWs, setCreateWsRaw] = useState<string>(() => { try { return localStorage.getItem('fl:workspace') ?? 'public' } catch { return 'public' } })
  const setCreateWs = (id: string) => { setCreateWsRaw(id); try { localStorage.setItem('fl:workspace', id) } catch { /* 프라이빗 모드 */ } }
  useEffect(() => { if (f && !fleet.isFetching && wsWritable.length && !wsWritable.some((w) => w.id === createWs)) setCreateWsRaw('public') }, [f, fleet.isFetching, wsWritable, createWs])

  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<FleetFilter>('all')
  const searchRef = useRef<HTMLInputElement>(null)
  const [favs, setFavs] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem('fl:mockfav') ?? '[]') as string[]) } catch { return new Set() } })
  const toggleFav = (id: string) => setFavs((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); try { localStorage.setItem('fl:mockfav', JSON.stringify([...n])) } catch { /* */ } return n })
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<Kind | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState<MockServerDetail | null>(null)
  const [ask, setAsk] = useState<AskSpec | null>(null)

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['mock-fleet'] }); qc.invalidateQueries({ queryKey: ['mock-servers'] }) }
  const create = useMutation({
    mutationFn: () => mocksApi.create({ name: name.trim() || slug.trim(), slug: slug.trim(), type: creating ?? 'HTTP', workspaceId: createWs === 'public' ? null : createWs }),
    onSuccess: (d) => { setName(''); setSlug(''); setError(null); setCreating(null); invalidate(); navigate(`/mocks/${d.id}`) },
    onError: (e) => setError(apiErrorMessage(e)),
  })
  const toggle = useMutation({ mutationFn: (s: MockFleetServer) => mocksApi.update(s.id, { enabled: !s.enabled }), onSuccess: invalidate, onError: (e) => toast(apiErrorMessage(e, '변경 실패'), 'error') })
  const remove = useMutation({ mutationFn: (id: string) => mocksApi.remove(id), onSuccess: invalidate, onError: (e) => toast(apiErrorMessage(e, '삭제 실패'), 'error') })
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => mocksApi.update(v.id, { name: v.name }), onSuccess: () => { invalidate(); toast('이름을 바꿨습니다.', 'ok') }, onError: (e) => toast(apiErrorMessage(e, '이름 변경 실패'), 'error') })
  const move = useMutation({ mutationFn: (v: { id: string; workspaceId: string }) => mocksApi.update(v.id, { workspaceId: v.workspaceId }), onSuccess: () => { invalidate(); toast('워크스페이스를 옮겼습니다.', 'ok') }, onError: (e) => toast(apiErrorMessage(e, '이동 실패'), 'error') })
  const duplicate = useMutation({
    mutationFn: async (s: MockFleetServer) => {
      const d = await mocksApi.get(s.id)
      let n = 2; let candidate = `${s.slug}-${n}`.slice(0, 40)
      for (; n < 30; n++) { candidate = `${s.slug.slice(0, 40 - String(n).length - 1)}-${n}`; if ((await mocksApi.slugCheck(candidate)).available) break }
      const created = await mocksApi.create({ name: `${s.name} (복제)`, slug: candidate, type: s.kind === 'TCP' ? 'TCP' : 'HTTP', workspaceId: s.workspaceId === 'public' ? null : s.workspaceId })
      const spec = d.spec?.tcp ? { ...d.spec, tcp: { ...d.spec.tcp, port: (d.spec.tcp.port ?? 9091) + 1 } } : d.spec // TCP 포트 충돌 방지 — 포트 +1 · 꺼서 복제
      await mocksApi.updateSpec(created.id, spec ?? { routes: [] }, { note: `${s.slug} 복제` })
      if (d.spec?.tcp) await mocksApi.update(created.id, { enabled: false })
      return created
    },
    onSuccess: (d) => { invalidate(); toast(`'${d.name}' 으로 복제했습니다(slug ${d.slug}).`, 'ok') },
    onError: (e) => toast(apiErrorMessage(e, '복제 실패'), 'error'),
  })
  const bulk = useMutation({
    mutationFn: async (op: { kind: 'on' | 'off' | 'delete' | 'move'; workspaceId?: string }) => {
      const ids = [...selected]
      for (const id of ids) {
        if (op.kind === 'delete') await mocksApi.remove(id)
        else if (op.kind === 'move') await mocksApi.update(id, { workspaceId: op.workspaceId })
        else await mocksApi.update(id, { enabled: op.kind === 'on' })
      }
      return ids.length
    },
    onSuccess: (n, op) => { invalidate(); setSelected(new Set()); toast(`${n}개 ${op.kind === 'delete' ? '삭제' : op.kind === 'on' ? '켜기' : op.kind === 'off' ? '끄기' : '이동'} 완료`, 'ok') },
    onError: (e) => { invalidate(); toast(apiErrorMessage(e, '일괄 작업 실패'), 'error') },
  })

  // 검색·필터 → 노드 흐리기(배치는 그대로)
  const qq = q.trim().toLowerCase()
  const match = useCallback((s: MockFleetServer): boolean => {
    const st = serverState(s)
    if (filter === 'on' && st !== 'on') return false
    if (filter === 'off' && st === 'on') return false
    if (filter === 'live' && !(s.recentRequests > 0)) return false
    if (filter === 'unmatched' && !(s.unmatchedRequests > 0)) return false
    if (filter === 'fav' && !favs.has(s.id)) return false
    if (!qq) return true
    const hay = `${s.name} ${s.slug} ${s.routeLabels.join(' ')} ${s.tcpPort ?? ''} ${s.protocolName ?? ''} ${wsName(s.workspaceId)}`.toLowerCase()
    return hay.includes(qq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qq, filter, favs, f])
  const matchActive = !!qq || filter !== 'all'
  const matched = useMemo(() => (matchActive ? servers.filter(match) : servers), [servers, match, matchActive])

  const slugFormatOk = /^[a-z0-9-]{3,40}$/.test(slug.trim())
  const [slugTaken, setSlugTaken] = useState<boolean | null>(null)
  useEffect(() => {
    setSlugTaken(null)
    if (!slugFormatOk) return
    const t = setTimeout(() => { mocksApi.slugCheck(slug.trim()).then((r) => setSlugTaken(!r.available)).catch(() => setSlugTaken(null)) }, 350)
    return () => clearTimeout(t)
  }, [slug, slugFormatOk])
  const slugOk = slugFormatOk && slugTaken !== true

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable
      if (!typing && (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.code === 'KeyF'))) { e.preventDefault(); searchRef.current?.focus() }
      if (e.key === 'Escape' && !typing && selectMode) { setSelectMode(false); setSelected(new Set()) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectMode])

  const onAction = useCallback((s: MockFleetServer, action: ServerAction, arg?: string) => {
    switch (action) {
      case 'toggle': toggle.mutate(s); break
      case 'fav': toggleFav(s.id); break
      case 'copyUrl': void navigator.clipboard?.writeText(mockBaseUrl(s.slug, me?.tenant)).then(() => toast('base URL 복사됨', 'ok')).catch(() => {}); break
      case 'rename': setAsk({ title: '이름 바꾸기', input: { label: '이름', initial: s.name }, confirmLabel: '변경', onConfirm: (v) => rename.mutate({ id: s.id, name: v }) }); break
      case 'duplicate': duplicate.mutate(s); break
      case 'export': mocksApi.get(s.id).then(setExporting).catch((e) => toast(apiErrorMessage(e, '불러오기 실패'), 'error')); break
      case 'move': if (arg && arg !== s.workspaceId) move.mutate({ id: s.id, workspaceId: arg }); break
      case 'goFlow': if (arg) navigate(`/flows/${arg}`); break
      case 'delete': setAsk({ title: 'Mock 서버 삭제', danger: true, confirmLabel: '삭제', message: `'${s.name}' Mock 서버를 삭제할까요? 되돌릴 수 없습니다.${(s.usedBy?.length ?? 0) ? ` 이 Mock 을 쓰는 워크플로 ${s.usedBy!.length}개가 호출에 실패하게 됩니다.` : ''}`, onConfirm: () => remove.mutate(s.id) }); break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.tenant])
  const onToggleSelect = useCallback((s: MockFleetServer) => {
    setSelectMode(true)
    setSelected((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })
  }, [])
  const onCreateIn = useCallback((wsId: string) => { setCreateWs(wsId); setCreating('HTTP'); setError(null) }, [])
  const onOpen = useCallback((s: MockFleetServer) => navigate(`/mocks/${s.id}`), [navigate])

  const stats = {
    total: servers.length,
    on: servers.filter((s) => serverState(s) === 'on').length,
    ports: (f?.ports ?? []).filter((p) => p.state === 'LISTENING').length,
    failed: (f?.ports ?? []).filter((p) => p.state === 'FAILED').length,
    live: servers.filter((s) => s.recentRequests > 0).length,
    unmatched: servers.filter((s) => s.unmatchedRequests > 0).length,
    ws: (f?.workspaces ?? []).filter((w) => w.mine || servers.some((s) => s.workspaceId === w.id)).length,
    readOnlyWs: (f?.workspaces ?? []).filter((w) => (!w.mine && servers.some((s) => s.workspaceId === w.id)) || w.myRole === 'VIEWER').length,
  }
  const selectedServers = servers.filter((s) => selected.has(s.id))
  const selectedEditable = selectedServers.every((s) => s.readable && s.myRole !== 'VIEWER')

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '28px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>Mock 서버</h1>
              <span style={metaMono}>{servers.length}</span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--fl-text-muted)', maxWidth: 680 }}>
              모든 워크스페이스의 Mock 을 <b>실제 서버처럼</b> — 어떤 포트가 열려 있고 무엇이 서빙 중인지 한눈에. 워크스페이스별 행 목록이며, 행을 클릭하면 편집기, 행 끝의 ⏻ 로 켜고 끄고 ⋯ 로 나머지 작업을 합니다. 내 워크스페이스가 아니면 읽기 전용(🔒)입니다.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {canEditGlobal && <button onClick={() => setImporting(true)} style={ghostBtn} title="내보내기 JSON 을 붙여넣어 새 Mock 서버로">⬇ 가져오기</button>}
            {canEditGlobal && <button onClick={() => { setCreating('HTTP'); setError(null) }} style={{ ...primaryBtn, ...(creating === 'HTTP' ? { opacity: 0.6 } : null) }}>+ HTTP Mock</button>}
            {canEditGlobal && <button onClick={() => { setCreating('TCP'); setError(null) }} style={{ ...primaryBtn, background: 'var(--fl-cat-tcp, #7c5cff)', ...(creating === 'TCP' ? { opacity: 0.6 } : null) }}>+ TCP Mock</button>}
          </div>
        </div>

        {creating && (
          <div style={createRow}>
            <span style={{ ...kindPill, background: creating === 'TCP' ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-primary)' }}>{creating === 'TCP' ? '🔌 TCP' : '🌐 HTTP'}</span>
            <select aria-label="만들 워크스페이스" value={createWs} onChange={(e) => setCreateWs(e.target.value)} style={selectStyle} title="어느 워크스페이스에 만들지">
              {(wsWritable.length ? wsWritable : [{ id: 'public', name: '공용', kind: 'PUBLIC' as const }]).map((w) => (
                <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>
              ))}
            </select>
            <input style={input} placeholder={creating === 'TCP' ? '이름 (예: 코어뱅킹 잔액조회)' : '이름 (예: 결제 게이트웨이)'} value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="이름" />
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input style={{ ...input, fontFamily: 'var(--fl-font-mono)', paddingRight: 84, borderColor: slugTaken === true ? 'var(--fl-fail)' : undefined }} aria-label="slug"
                placeholder={creating === 'TCP' ? 'slug (예: corebank)' : 'slug (예: pay-mock)'} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} onKeyDown={(e) => { if (e.key === 'Enter' && slugOk) create.mutate() }} />
              {slugFormatOk && slugTaken !== null && (
                <span style={{ position: 'absolute', right: 10, fontSize: 11, fontWeight: 700, pointerEvents: 'none', color: slugTaken ? 'var(--fl-fail)' : 'var(--fl-ok)' }}>{slugTaken ? '✕ 사용 중' : '✓ 사용 가능'}</span>
              )}
            </span>
            <button style={{ ...primaryBtn, opacity: slugOk ? 1 : 0.5 }} disabled={!slugOk || create.isPending} onClick={() => create.mutate()}>만들기</button>
            <button style={ghostBtn} onClick={() => { setCreating(null); setError(null) }}>취소</button>
            <span style={{ flexBasis: '100%', fontSize: 11.5, color: 'var(--fl-text-muted)' }}>
              {creating === 'HTTP' ? `slug 는 서빙 주소(/mock/{slug})라 워크스페이스와 무관하게 전체에서 유일해야 합니다. 만들면 경로·응답·조건 분기·콜백을 정의합니다.` : '만들면 빈 포트를 골라 고정길이 전문(길이 프리픽스) 리스너를 엽니다 — 워크플로 TCP 노드 대상. 포트·레이아웃·규칙은 편집기에서.'}
            </span>
          </div>
        )}
        {error && <p style={{ color: 'var(--fl-fail)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}
        {fleet.isError && <p style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 18 }}>서버 현황을 불러오지 못했습니다: {apiErrorMessage(fleet.error)}</p>}

        {/* 현황 스트립 — 클릭 = 필터 */}
        {f && servers.length > 0 && (
          <div style={statsGrid} aria-label="현황">
            {([
              ['all', '서버', stats.total, 'var(--fl-text)', `HTTP ${servers.filter((s) => s.kind !== 'TCP').length} · TCP ${servers.filter((s) => s.kind === 'TCP').length}`],
              ['on', '서빙 중', stats.on, 'var(--fl-ok)', `${stats.total - stats.on}개 꺼짐`],
              [null, '열린 포트', stats.ports, stats.failed ? 'var(--fl-fail)' : 'var(--fl-ok)', stats.failed ? `${stats.failed}개 바인딩 실패` : `HTTP :${f.httpPort} 포함`],
              ['live', '요청 들어오는 중', stats.live, stats.live ? 'var(--fl-ok)' : 'var(--fl-text-muted)', '최근 60초'],
              ['unmatched', '무매칭 요청 있음', stats.unmatched, stats.unmatched ? 'var(--fl-fail)' : 'var(--fl-text-muted)', stats.unmatched ? '규칙이 없어 404/빈 응답' : '규칙 밖 요청 없음'],
              [null, '워크스페이스', stats.ws, 'var(--fl-text)', stats.readOnlyWs ? `읽기 전용 ${stats.readOnlyWs}` : '전부 편집 가능'],
            ] as Array<[FleetFilter | null, string, number, string, string]>).map(([k, label, n, color, sub]) => (
              k ? (
                <button key={label} onClick={() => setFilter(filter === k ? 'all' : k)} aria-pressed={filter === k} style={{ ...statCard, cursor: 'pointer', ...(filter === k && k !== 'all' ? statOn : null) }} title={`클릭하면 ${label}만 강조`}>
                  <span style={statLabel}>{label}</span><span style={{ ...statNum, color }}>{n}</span><span style={statSub}>{sub}</span>
                </button>
              ) : (
                <div key={label} style={statCard}><span style={statLabel}>{label}</span><span style={{ ...statNum, color }}>{n}</span><span style={statSub}>{sub}</span></div>
              )
            ))}
          </div>
        )}

        {/* 툴바 — 검색·필터·선택 */}
        {f && servers.length > 0 && (
          <div style={toolbar}>
            <span style={{ position: 'relative', flex: 1, minWidth: 220, display: 'inline-flex', alignItems: 'center' }}>
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() } }}
                placeholder="검색 — 이름 · slug · 경로 · 포트 · 워크스페이스   ( / )" aria-label="Mock 검색" style={{ ...input, width: '100%', minWidth: 0, paddingRight: q ? 30 : undefined }} />
              {q && <button onClick={() => setQ('')} aria-label="검색 지우기" style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 14 }}>×</button>}
            </span>
            <div style={segWrap} role="group" aria-label="필터">
              {([['all', '전체'], ['on', '켜짐'], ['off', '꺼짐'], ['live', '요청 중'], ['fav', '★']] as Array<[FleetFilter, string]>).map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} style={{ ...segBtn, ...(filter === k ? segOn : null) }}>{label}</button>
              ))}
            </div>
            {matchActive && <span style={metaMono} aria-label="일치 수">{matched.length}/{servers.length} 일치</span>}
            {canEditGlobal && <button onClick={() => { setSelectMode((v) => !v); setSelected(new Set()) }} style={{ ...ghostBtn, ...(selectMode ? { borderColor: 'var(--fl-primary)', color: 'var(--fl-primary)' } : null) }} title="여러 Mock 을 골라 한 번에 켜기/끄기/이동/삭제 (Ctrl+클릭으로도 선택)">{selectMode ? '선택 취소' : '☑ 선택'}</button>}
          </div>
        )}
        {selectMode && (
          <div style={actionBar}>
            <span style={{ fontSize: 12.5 }}>{selected.size}개 선택{!selectedEditable && selected.size > 0 ? ' (읽기 전용 포함 — 작업 불가)' : ''}</span>
            <button style={miniBtn} onClick={() => setSelected(new Set(matched.filter((s) => s.readable && s.myRole !== 'VIEWER').map((s) => s.id)))}>모두 선택</button>
            <button style={miniBtn} disabled={!selected.size || !selectedEditable || bulk.isPending} onClick={() => bulk.mutate({ kind: 'on' })}>● 켜기</button>
            <button style={miniBtn} disabled={!selected.size || !selectedEditable || bulk.isPending} onClick={() => bulk.mutate({ kind: 'off' })}>○ 끄기</button>
            {wsWritable.length > 1 && (
              <select aria-label="선택 워크스페이스 이동" value="" disabled={!selected.size || !selectedEditable || bulk.isPending} onChange={(e) => { if (e.target.value) bulk.mutate({ kind: 'move', workspaceId: e.target.value }) }} style={{ ...selectStyle, height: 30, padding: '4px 8px' }}>
                <option value="">워크스페이스로 이동…</option>
                {wsWritable.map((w) => <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>)}
              </select>
            )}
            <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} disabled={!selected.size || !selectedEditable || bulk.isPending}
              onClick={() => setAsk({ title: 'Mock 서버 일괄 삭제', danger: true, confirmLabel: `${selected.size}개 삭제`, message: `선택한 ${selected.size}개 Mock 서버를 삭제할까요? 되돌릴 수 없습니다.`, onConfirm: () => bulk.mutate({ kind: 'delete' }) })}>🗑 삭제</button>
          </div>
        )}

        {/* 인벤토리 — 유일한 보기 */}
        {f && servers.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={sectionHead}>
              <span style={sectionLabel}>🖧 서버 인벤토리</span>
              <span style={{ ...metaMono, marginLeft: 8 }}>{host} · 실제 리스너 기준 · {new Date(f.generatedAt).toLocaleTimeString()} 갱신 · 행 클릭=편집기 · Ctrl+클릭=선택</span>
            </div>
            <MockInventory fleet={f} host={host} tenant={me?.tenant} match={matchActive ? match : null} selected={selected} selectMode={selectMode} favs={favs}
              canEditGlobal={canEditGlobal} wsOptions={wsWritable} onOpen={onOpen} onToggleSelect={onToggleSelect} onAction={onAction} onCreateIn={onCreateIn} />
          </div>
        )}

        {f && servers.length === 0 && !creating && (
          <div style={emptyBox}>
            <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>첫 Mock 서버를 만들어 보세요</div>
            <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6, maxWidth: 520, marginInline: 'auto' }}>
              <b>HTTP</b> 는 slug 를 정하면 <code style={codeChip}>/mock/&#123;slug&#125;/**</code> 로 즉시 서빙되고, <b>TCP</b> 는 빈 포트에 고정길이 전문 리스너를 엽니다. 만들면 여기에 실제 서버처럼 나타납니다.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
              {canEditGlobal && <button onClick={() => { setCreating('HTTP'); setError(null) }} style={primaryBtn}>+ HTTP Mock</button>}
              {canEditGlobal && <button onClick={() => { setCreating('TCP'); setError(null) }} style={{ ...primaryBtn, background: 'var(--fl-cat-tcp, #7c5cff)' }}>+ TCP Mock</button>}
              {canEditGlobal && <button onClick={() => setImporting(true)} style={ghostBtn}>⬇ 내보낸 JSON 가져오기</button>}
            </div>
          </div>
        )}
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      {importing && <MockImportDialog workspaceId={createWs === 'public' ? null : createWs} onClose={() => setImporting(false)} onImported={() => invalidate()} />}
      {exporting && <MockExportDialog mock={exporting} onClose={() => setExporting(null)} />}
    </AppShellTier1>
  )
}

// ---------- 스타일 ----------
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const input: CSSProperties = { padding: '0 12px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13.5, minWidth: 200 }
const selectStyle: CSSProperties = { padding: '8px 10px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const kindPill: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 38, padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', color: '#fff', fontWeight: 700, fontSize: 12.5 }
const createRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap', padding: 14, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const statsGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10, marginTop: 18 }
const statCard: CSSProperties = { display: 'grid', gap: 3, textAlign: 'left', padding: '12px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', color: 'var(--fl-text)', boxShadow: 'var(--fl-shadow)' }
const statOn: CSSProperties = { borderColor: 'var(--fl-primary)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--fl-primary) 30%, transparent)' }
const statLabel: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontWeight: 600 }
const statNum: CSSProperties = { fontSize: 24, fontWeight: 800, fontFamily: 'var(--fl-font-head)', lineHeight: 1.1 }
const statSub: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)' }
const toolbar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }
const actionBar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, padding: '8px 12px', border: '1px solid color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))', borderRadius: 'var(--fl-radius-sm)', background: 'color-mix(in srgb, var(--fl-primary) 6%, var(--fl-surface))', flexWrap: 'wrap' }
const segWrap: CSSProperties = { display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }
const segBtn: CSSProperties = { padding: '0 12px', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }
const segOn: CSSProperties = { background: 'var(--fl-primary)', color: '#fff' }
const sectionHead: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 8, flexWrap: 'wrap' }
const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--fl-text)' }
const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' }
const ghostBtn: CSSProperties = { height: 38, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: '48px 40px', textAlign: 'center', color: 'var(--fl-text-muted)', marginTop: 24 }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
