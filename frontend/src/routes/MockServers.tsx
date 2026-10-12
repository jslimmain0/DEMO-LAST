import { PageHeader } from '../components/PageHeader'
import { AppIcon } from '../components/AppIcon'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MockFleetServer, MockServerDetail } from '../api/types'

import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { MockExportDialog, MockImportDialog } from '../components/MockTransferDialog'
import { MockInventory, serverState } from '../components/MockInventory'
import type { FleetFilter, ServerAction } from '../components/MockInventory'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { matchesCatalog, type MockSort } from '../lib/catalog'
import { useCatalogNavigation } from '../lib/useCatalogNavigation'
import { ui } from '../design/ui'
import { MockNavigator } from '../components/MockNavigator'
import { locatedFleet, mockLocation } from '../lib/mockCatalog'
import { ResourceLocationBar } from '../components/ResourceLocationBar'

type Kind = 'HTTP' | 'TCP'

/**
 * Mock 서버 화면 = **서버 인벤토리 하나**(카드/그래프 없음). 모든 워크스페이스의 Mock 을 실제 서버처럼 —
 * 현황 스트립(클릭=필터) · 검색/필터/선택 · 만들기(대상 워크스페이스 선택) · 가져오기 · [MockInventory](../components/MockInventory.tsx)
 * (상단 포트 스트립 + 워크스페이스 그룹(내 것 먼저, 남의 것 접힘·🔒) + 서버 행(LED·포트·주소·이름·상태·구성·트래픽·↗·vN·⏻·⋯ —
 * 켜기/끄기·이름·복제·내보내기·이동·삭제·즐겨찾기·URL 복사·↗ 워크플로, Ctrl+클릭/선택 모드로 일괄 작업)).
 * 5초 폴링(살아있음·리스너 상태). 편집은 행 클릭 → 편집기.
 */
export function MockServers() {
  const { mockBaseUrl } = useApi()

  const qc = useQueryClient()
  const navigate = useNavigate()
  const catalog = useCatalogNavigation('mocks')
  const params = new URLSearchParams(catalog.search)
  const { canEdit: canEditUser } = usePermissions()
  const { me, desktop } = useAuth()
  const scope = useWorkspace()
  const { agentApi } = scope
  const canEditGlobal = canEditUser
  const localId = scope.workspaces.find(w => w.origin === 'local')?.id ?? 'local'
  const localApi = useMemo(() => agentApi('local', localId), [agentApi, localId])
  const centralApi = useMemo(() => agentApi('server', 'public'), [agentApi])
  const fleet = useQuery({ queryKey: ['mock-fleet', 'server', scope.remoteKey], queryFn: centralApi.mocksApi.fleet, enabled: scope.connected, refetchInterval: 5000, retry: false })
  const pcFleet = useQuery({ queryKey: ['mock-fleet', 'local', localId], queryFn: localApi.mocksApi.fleet, enabled: !!desktop, refetchInterval: 5000, retry: false })
  const serverWorkspace = params.get('serverSpace') ?? ''
  const setServerWorkspace = (value: string) => { const next = new URLSearchParams(params); if (value) next.set('serverSpace', value); else next.delete('serverSpace'); catalog.update({ page: 1 }, next.toString()) }
  const f = useMemo(() => {
    const pc = pcFleet.data ? locatedFleet(pcFleet.data, 'local') : null
    const server = scope.connected && fleet.data ? locatedFleet(fleet.data, 'server') : null
    if (!pc && !server) return undefined
    return { ...(pc ?? server!), workspaces: [...(pc?.workspaces ?? []), ...(server?.workspaces ?? []).filter(w => !serverWorkspace || w.id === `server:${serverWorkspace}`)],
      servers: [...(pc?.servers ?? []), ...(server?.servers ?? []).filter(s => !serverWorkspace || s.workspaceId === `server:${serverWorkspace}`)],
      ports: [...(pc?.ports ?? []), ...(server?.ports ?? []).filter(p => !serverWorkspace || !p.workspaceId || p.workspaceId === `server:${serverWorkspace}`)] }
  }, [pcFleet.data, fleet.data, scope.connected, serverWorkspace])
  const servers = useMemo(() => f?.servers ?? [], [f])
  const host = new URL(mockBaseUrl('')).hostname
  const wsWritable = useMemo(() => (f?.workspaces ?? []).filter((w) => w.myRole === 'OWNER' || w.myRole === 'EDITOR'), [f])
  const wsDestinations = useMemo(() => (f?.workspaces ?? []).filter(w => w.myRole === 'OWNER' || w.myRole === 'EDITOR').sort((a, b) => a.name.localeCompare(b.name, 'ko')), [f])
  const wsName = (id: string) => f?.workspaces.find((w) => w.id === id)?.name ?? '공용'

  // 만들기/가져오기 대상 워크스페이스 — 대시보드와 같은 마지막 선택(fl:workspace) 기억
  const [createWs, setCreateWs] = useState<string>(desktop ? `local:${localId}` : 'server:public')
  const createLocation = mockLocation(createWs)
  const mocksApi = useMemo(() => agentApi(createLocation.origin, createLocation.id).mocksApi, [agentApi, createLocation.origin, createLocation.id])
  const apiFor = (s: MockFleetServer) => { const location = mockLocation(s.workspaceId); return scope.agentApi(location.origin, location.id).mocksApi }
  const findMock = (id: string) => servers.find(s => s.id === id)!
  useEffect(() => { if (f && !fleet.isFetching && wsWritable.length && !wsWritable.some((w) => w.id === createWs)) setCreateWs(wsWritable[0].id) }, [f, fleet.isFetching, wsWritable, createWs])

  const q = catalog.view.search
  const filter = catalog.view.filter as FleetFilter
  const kindFilter = catalog.view.kind as 'all' | Kind
  const sort = catalog.view.sort as MockSort
  const setQ = (search: string) => catalog.update({ search, page: 1 })
  const setFilter = (filter: FleetFilter) => catalog.update({ filter, page: 1 })
  const setKindFilter = (kind: 'all' | Kind) => catalog.update({ kind, page: 1 })
  const setSort = (sort: MockSort) => catalog.update({ sort, page: 1 })
  const searchRef = useRef<HTMLInputElement>(null)
  const favKey = `fl:mockfav:${scope.scopeKey}`
  const [favs, setFavs] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem(favKey) ?? '[]') as string[]) } catch { return new Set() } })
  const toggleFav = (id: string) => setFavs((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); try { localStorage.setItem(favKey, JSON.stringify([...n])) } catch { /* */ } return n })
  const [bulkDestination, setBulkDestination] = useState('')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!f) return
    const ids = new Set(servers.map(s => s.id))
    setSelected(previous => [...previous].every(id => ids.has(id)) ? previous : new Set([...previous].filter(id => ids.has(id))))
  }, [f, servers])
  const [creating, setCreating] = useState<Kind | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState<MockServerDetail | null>(null)
  const [ask, setAsk] = useState<AskSpec | null>(null)

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['mock-fleet'] }); qc.invalidateQueries({ queryKey: ['mock-servers'] }); qc.invalidateQueries({ queryKey: ['mock-explorer'] }) }
  const create = useMutation({
    mutationFn: () => mocksApi.create({ name: name.trim() || slug.trim(), slug: slug.trim(), type: creating ?? 'HTTP', workspaceId: createLocation.id }),
    onSuccess: () => { setName(''); setSlug(''); setError(null); setCreating(null); invalidate() },
    onError: (e) => setError(apiErrorMessage(e)),
  })
  // 화면을 떠나도 저장과 캐시 갱신은 완료하되, 이전 공간의 상세 화면으로 이동하지 않는다.
  const createMock = () => { if (!create.isPending) create.mutate(undefined, { onSuccess: d => { const link = catalog.detail(d.id, createLocation); navigate(link.to, { state: link.state }) } }) }
  const toggle = useMutation({ mutationFn: (s: MockFleetServer) => apiFor(s).update(mockLocation(s.id).id, { enabled: !s.enabled }), onSuccess: invalidate, onError: (e) => toast(apiErrorMessage(e, '변경 실패'), 'error') })
  const remove = useMutation({ mutationFn: (id: string) => apiFor(findMock(id)).remove(mockLocation(id).id), onSuccess: invalidate, onError: (e) => toast(apiErrorMessage(e, '삭제 실패'), 'error') })
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => apiFor(findMock(v.id)).update(mockLocation(v.id).id, { name: v.name }), onSuccess: () => { invalidate(); toast('이름을 바꿨습니다.', 'ok') }, onError: (e) => toast(apiErrorMessage(e, '이름 변경 실패'), 'error') })
  const move = useMutation({ mutationFn: (v: { id: string; workspaceId: string }) => { if (mockLocation(v.id).origin !== mockLocation(v.workspaceId).origin) throw new Error('내 PC와 서버 사이에는 복제해서 옮겨주세요.'); return apiFor(findMock(v.id)).update(mockLocation(v.id).id, { workspaceId: mockLocation(v.workspaceId).id }) }, onSuccess: () => { invalidate(); toast('워크스페이스를 옮겼습니다.', 'ok') }, onError: (e) => toast(apiErrorMessage(e, '이동 실패'), 'error') })
  const duplicate = useMutation({
    mutationFn: async (s: MockFleetServer) => {
      const api = apiFor(s)
      const d = await api.get(mockLocation(s.id).id)
      let n = 2; let candidate = `${s.slug}-${n}`.slice(0, 40)
      for (; n < 30; n++) { candidate = `${s.slug.slice(0, 40 - String(n).length - 1)}-${n}`; if ((await api.slugCheck(candidate)).available) break }
      const created = await api.create({ name: `${s.name} (복제)`, slug: candidate, type: s.kind === 'TCP' ? 'TCP' : 'HTTP', workspaceId: mockLocation(s.workspaceId).id })
      const spec = d.spec?.tcp ? { ...d.spec, tcp: { ...d.spec.tcp, port: (d.spec.tcp.port ?? 9091) + 1 } } : d.spec // TCP 포트 충돌 방지 — 포트 +1 · 꺼서 복제
      await api.updateSpec(created.id, spec ?? { routes: [] }, { note: `${s.slug} 복제` })
      if (d.spec?.tcp) await api.update(created.id, { enabled: false })
      return created
    },
    onSuccess: (d) => { invalidate(); toast(`'${d.name}' 으로 복제했습니다(slug ${d.slug}).`, 'ok') },
    onError: (e) => toast(apiErrorMessage(e, '복제 실패'), 'error'),
  })
  const bulk = useMutation({
    mutationFn: async (op: { kind: 'on' | 'off' | 'delete' | 'move'; workspaceId?: string }) => {
      const ids = [...selected]
      if (op.kind === 'move') {
        const target = mockLocation(op.workspaceId!)
        if (ids.some(id => mockLocation(id).origin !== target.origin)) throw new Error('같은 실행 위치의 Mock만 한 번에 이동할 수 있습니다. 내 PC와 서버 사이에는 복제해서 옮겨주세요.')
      }
      let completed = 0
      try {
        for (const id of ids) {
          const api = apiFor(findMock(id)), source = mockLocation(id)
          if (op.kind === 'delete') await api.remove(source.id)
          else if (op.kind === 'move') await api.update(source.id, { workspaceId: mockLocation(op.workspaceId!).id })
          else await api.update(source.id, { enabled: op.kind === 'on' })
          completed++
          setSelected(previous => { const remaining = new Set(previous); remaining.delete(id); return remaining })
        }
      } catch (error) {
        throw new Error(`${completed}개 완료 · ${ids.length - completed}개 미완료. ${apiErrorMessage(error)} 남은 선택으로 다시 시도하세요.`)
      }
      return ids.length
    },
    onSuccess: (n, op) => { invalidate(); setBulkDestination(''); toast(`${n}개 ${op.kind === 'delete' ? '삭제' : op.kind === 'on' ? '켜기' : op.kind === 'off' ? '끄기' : '이동'} 완료`, 'ok') },
    onError: (e) => { invalidate(); toast(apiErrorMessage(e, '일괄 작업 실패'), 'error') },
  })

  // 검색·필터 → 노드 흐리기(배치는 그대로)
  const qq = q.trim().toLowerCase()
  const match = useCallback((s: MockFleetServer): boolean => {
    const st = serverState(s)
    if (filter === 'on' && st !== 'on') return false
    if (filter === 'off' && st !== 'off') return false
    if (filter === 'fail' && st !== 'fail') return false
    if (kindFilter !== 'all' && (s.kind === 'TCP' ? 'TCP' : 'HTTP') !== kindFilter) return false
    if (filter === 'live' && !(s.recentRequests > 0)) return false
    if (filter === 'unmatched' && !(s.unmatchedRequests > 0)) return false
    if (filter === 'fav' && !favs.has(s.id)) return false
    if (!qq) return true
    return matchesCatalog(qq, [s.name, s.slug, s.id, s.routeLabels.join(' '), s.tcpPort, s.protocolName, s.environment, s.listener?.advertisedAddress, wsName(s.workspaceId)])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qq, filter, kindFilter, favs, f])
  const matchActive = !!qq || filter !== 'all' || kindFilter !== 'all'
  const matched = useMemo(() => (matchActive ? servers.filter(match) : servers), [servers, match, matchActive])

  const slugFormatOk = /^[a-z0-9-]{3,40}$/.test(slug.trim())
  const [slugTaken, setSlugTaken] = useState<boolean | null>(null)
  useEffect(() => {
    setSlugTaken(null)
    if (!slugFormatOk) return
    let active = true
    const t = setTimeout(() => { mocksApi.slugCheck(slug.trim()).then((r) => { if (active) setSlugTaken(!r.available) }).catch(() => { if (active) setSlugTaken(null) }) }, 350)
    return () => { active = false; clearTimeout(t) }
  }, [slug, slugFormatOk, mocksApi])
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
      case 'copyUrl': { const location = mockLocation(s.workspaceId); void navigator.clipboard?.writeText(scope.agentApi(location.origin, location.id).mockBaseUrl(s.slug, me?.tenant, s.basePath)).then(() => toast('주소를 복사했습니다.', 'ok')).catch(() => toast('주소를 복사하지 못했습니다.', 'error')); break }
      case 'rename': setAsk({ title: '이름 바꾸기', input: { label: '이름', initial: s.name }, confirmLabel: '변경', onConfirm: (v) => rename.mutate({ id: s.id, name: v }) }); break
      case 'duplicate': duplicate.mutate(s); break
      case 'export': apiFor(s).get(mockLocation(s.id).id).then(setExporting).catch((e) => toast(apiErrorMessage(e, '불러오기 실패'), 'error')); break
      case 'move': if (arg && arg !== s.workspaceId) move.mutate({ id: s.id, workspaceId: arg }); break
      case 'goFlow': if (arg) navigate(`/flows/${arg}?space=${encodeURIComponent(s.workspaceId)}`); break
      case 'delete': setAsk({ title: 'Mock 서버 삭제', danger: true, confirmLabel: '삭제', message: `'${s.name}' Mock 서버를 삭제할까요? 되돌릴 수 없습니다.${(s.usedBy?.length ?? 0) ? ` 이 Mock 을 쓰는 워크플로 ${s.usedBy!.length}개가 호출에 실패하게 됩니다.` : ''}`, onConfirm: () => remove.mutate(s.id) }); break
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.tenant, scope.agentApi, servers, favs])
  const onToggleSelect = useCallback((s: MockFleetServer) => {
    setSelectMode(true)
    setSelected((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })
  }, [])
  const onCreateIn = useCallback((wsId: string) => { setCreateWs(wsId); setCreating('HTTP'); setError(null) }, [])
  const onOpen = (s: MockFleetServer) => { const link = catalog.detail(mockLocation(s.id).id, mockLocation(s.workspaceId)); navigate(link.to, { state: link.state }) }

  const stats = {
    total: servers.length,
    on: servers.filter((s) => serverState(s) === 'on').length,
    off: servers.filter((s) => serverState(s) === 'off').length,
    failed: servers.filter((s) => serverState(s) === 'fail').length,
    live: servers.filter((s) => s.recentRequests > 0).length,
    unmatched: servers.filter((s) => s.unmatchedRequests > 0).length,
    fav: servers.filter(s => favs.has(s.id)).length,
  }
  const selectedServers = servers.filter((s) => selected.has(s.id))
  const selectedEditable = canEditGlobal && selectedServers.every((s) => s.readable && s.myRole !== 'VIEWER')
  const selectedOrigins = new Set(selectedServers.map(s => mockLocation(s.id).origin))
  const canMoveSelection = selectedOrigins.size === 1

  return (
    <AppShellTier1 sidebarExtra={<MockNavigator />}>
      <div className="fl-page fl-mock-catalog">
        <PageHeader title="Mock" count={servers.length} description="내 PC와 서버의 테스트 대상을 함께 관리합니다. Mock을 열어 응답 규칙을 편집하세요." actions={<>
          {canEditGlobal && <button onClick={() => setImporting(true)} style={ghostBtn} title="내보내기 JSON을 가져와 새 Mock 만들기"><AppIcon name="upload" size={16} /> 가져오기</button>}
          {canEditGlobal && <button onClick={() => { setCreating('TCP'); setError(null) }} style={ghostBtn}>+ TCP Mock</button>}
          {canEditGlobal && <button onClick={() => { setCreating('HTTP'); setError(null) }} style={primaryBtn}>+ HTTP Mock</button>}
        </>} />

        <ResourceLocationBar combined serverWorkspaceId={serverWorkspace} onServerWorkspaceChange={setServerWorkspace} label="표시 범위" />
        {creating && (
          <div style={createRow}>
            <span style={{ ...kindPill, background: creating === 'TCP' ? 'var(--fl-cat-tcp)' : 'var(--fl-primary)' }}>{creating === 'TCP' ? 'TCP' : 'HTTP'}</span>
            <select aria-label="만들 워크스페이스" value={createWs} onChange={(e) => setCreateWs(e.target.value)} style={selectStyle} title="어느 워크스페이스에 만들지">
              {(wsWritable.length ? wsWritable : [{ id: createWs, name: createLocation.origin === 'local' ? '내 PC' : '서버 · 공용', kind: createLocation.origin === 'local' ? 'PERSONAL' : 'PUBLIC' }]).map((w) => (
                <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '개인 ·' : w.kind === 'TEAM' ? '팀 ·' : '공용 ·'} {w.name}</option>
              ))}
            </select>
            <input style={input} placeholder={creating === 'TCP' ? '이름 (예: 코어뱅킹 잔액조회)' : '이름 (예: 결제 게이트웨이)'} value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="이름" />
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input style={{ ...input, fontFamily: 'var(--fl-font-mono)', paddingRight: 84, borderColor: slugTaken === true ? 'var(--fl-fail)' : 'var(--fl-border)' }} aria-label="slug"
                placeholder={creating === 'TCP' ? 'slug (예: corebank)' : 'slug (예: pay-mock)'} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} onKeyDown={(e) => { if (e.key === 'Enter' && slugOk) createMock() }} />
              {slugFormatOk && slugTaken !== null && (
                <span style={{ position: 'absolute', right: 10, fontSize: 11, fontWeight: 700, pointerEvents: 'none', color: slugTaken ? 'var(--fl-fail)' : 'var(--fl-ok)' }}>{slugTaken ? '✕ 사용 중' : '✓ 사용 가능'}</span>
              )}
            </span>
            <button style={{ ...primaryBtn, opacity: slugOk ? 1 : 0.5 }} disabled={!slugOk || create.isPending} onClick={createMock}>만들기</button>
            <button style={ghostBtn} onClick={() => { setCreating(null); setError(null) }}>취소</button>
            <span style={{ flexBasis: '100%', fontSize: 12, color: 'var(--fl-text-muted)' }}>
              {creating === 'HTTP' ? 'slug는 이 워크스페이스 안에서 고유해야 합니다. 다른 공간에는 같은 slug를 사용할 수 있습니다. 경로·응답·조건·콜백은 만든 뒤 설정하세요.' : '만들면 빈 포트를 골라 고정길이 전문 리스너를 엽니다. 포트·레이아웃·규칙은 편집기에서 설정하세요.'}
            </span>
          </div>
        )}
        {error && <p style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 8 }}>{error}</p>}
        {fleet.isError && <p style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 18 }}>서버 현황을 불러오지 못했습니다: {apiErrorMessage(fleet.error)}</p>}
        {!scope.connected && <p role="status" style={{ color: 'var(--fl-text-muted)', fontSize: 13 }}>서버 연결이 필요합니다. 내 PC Mock은 계속 사용할 수 있습니다.</p>}
        {pcFleet.isError && <p role="alert" style={{ color: 'var(--fl-fail)', fontSize: 13 }}>내 PC Mock을 불러오지 못했습니다. <button onClick={() => void pcFleet.refetch()} style={miniBtn}>다시 확인</button></p>}

        {/* 상태와 필터를 한 곳에서 조작한다. */}
        {f && servers.length > 0 && (
          <div style={statusFilters} role="group" aria-label="Mock 상태 필터">
            {([
              ['all', '전체', stats.total], ['on', '켜짐', stats.on], ['off', '꺼짐', stats.off],
              ['fail', '실패', stats.failed], ['live', '요청 중', stats.live], ['unmatched', '규칙 불일치', stats.unmatched], ['fav', '즐겨찾기', stats.fav],
            ] as Array<[FleetFilter, string, number]>).map(([k, label, n]) => (
              <button key={k} onClick={() => setFilter(k)} aria-pressed={filter === k} style={{ ...statusFilter, ...(filter === k ? { color: 'var(--fl-primary)', borderBottomColor: 'var(--fl-primary)', background: 'color-mix(in srgb, var(--fl-primary) 5%, transparent)' } : {}) }}>
                {label}<span style={{ ...metaMono, color: 'inherit', marginLeft: 7 }}>{n}</span>
              </button>
            ))}
          </div>
        )}

        {/* 툴바 — 검색·필터·선택 */}
        {f && servers.length > 0 && (
          <div style={toolbar}>
            <span style={{ position: 'relative', flex: 1, minWidth: 220, display: 'inline-flex', alignItems: 'center' }}>
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() } }}
                placeholder="이름, 주소, 응답 경로 검색   ( / )" aria-label="Mock 검색" style={{ ...input, width: '100%', minWidth: 0, paddingRight: q ? 30 : undefined }} />
              {q && <button onClick={() => setQ('')} aria-label="검색 지우기" style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 14 }}>×</button>}
            </span>
            <select aria-label="Mock 종류 필터" value={kindFilter} onChange={e => setKindFilter(e.target.value as typeof kindFilter)} style={selectStyle}><option value="all">HTTP + TCP</option><option value="HTTP">HTTP만</option><option value="TCP">TCP만</option></select>
            <select aria-label="Mock 정렬" value={sort} onChange={e => setSort(e.target.value as MockSort)} style={selectStyle}><option value="name">이름순</option><option value="recent">최근 수정순</option><option value="state">실패·서빙 상태순</option><option value="port">포트순</option></select>
            {matchActive && <button onClick={() => { setQ(''); setFilter('all'); setKindFilter('all') }} style={miniBtn}>필터 초기화</button>}
            {matchActive && <span style={metaMono} aria-label="일치 수">{matched.length}/{servers.length} 일치</span>}
            {canEditGlobal && <button onClick={() => { setSelectMode((v) => !v); setSelected(new Set()) }} style={{ ...ghostBtn, borderColor: selectMode ? 'var(--fl-primary)' : 'var(--fl-border)', color: selectMode ? 'var(--fl-primary)' : 'var(--fl-text)' }} title="여러 Mock 을 골라 한 번에 켜기/끄기/이동/삭제 (Ctrl+클릭으로도 선택)">{selectMode ? '선택 취소' : '☑ 선택'}</button>}
          </div>
        )}
        {selectMode && (
          <div style={actionBar}>
            <span role="status" style={{ fontSize: 13 }}>{selected.size}개 선택{selected.size > matched.filter(s => selected.has(s.id)).length ? ` · 필터 밖 ${selected.size - matched.filter(s => selected.has(s.id)).length}개 포함` : ''}{!selectedEditable && selected.size > 0 ? ' (읽기 전용 포함 — 작업 불가)' : ''}</span>
            <button style={miniBtn} onClick={() => setSelected(previous => new Set([...previous, ...matched.filter((s) => s.readable && s.myRole !== 'VIEWER').map((s) => s.id)]))}>검색 결과 전체 선택 ({matched.filter(s => s.readable && s.myRole !== 'VIEWER').length})</button>
            {selected.size > 0 && <button style={miniBtn} onClick={() => setSelected(new Set())}>선택 비우기</button>}
            <button style={miniBtn} disabled={!selected.size || !selectedEditable || bulk.isPending} onClick={() => bulk.mutate({ kind: 'on' })}>● 켜기</button>
            <button style={miniBtn} disabled={!selected.size || !selectedEditable || bulk.isPending} onClick={() => bulk.mutate({ kind: 'off' })}>○ 끄기</button>
            {wsDestinations.length > 1 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <select aria-label="선택 Mock을 이동할 워크스페이스" value={bulkDestination} disabled={!selected.size || !selectedEditable || !canMoveSelection || bulk.isPending} onChange={(e) => setBulkDestination(e.target.value)} style={{ ...selectStyle, height: 30, padding: '4px 8px' }}>
                <option value="">이동할 공간 선택…</option>
                {wsDestinations.filter(w => selectedOrigins.has(mockLocation(w.id).origin)).map((w) => <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '내 PC ·' : w.kind === 'TEAM' ? '서버 팀 ·' : '서버 공용 ·'} {w.name}</option>)}
              </select>
              <button style={miniBtn} disabled={!bulkDestination || !selected.size || !selectedEditable || !canMoveSelection || bulk.isPending} onClick={() => bulk.mutate({ kind: 'move', workspaceId: bulkDestination })}>선택한 공간으로 이동</button>
              {selectedOrigins.size > 1 && <small style={{ color: 'var(--fl-text-muted)' }}>이동하려면 같은 위치의 Mock만 선택하세요.</small>}
              </span>
            )}
            <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} disabled={!selected.size || !selectedEditable || bulk.isPending}
              onClick={() => setAsk({ title: 'Mock 서버 일괄 삭제', danger: true, confirmLabel: `${selected.size}개 삭제`, message: `선택한 ${selected.size}개 Mock 서버를 삭제할까요? 되돌릴 수 없습니다.`, onConfirm: () => bulk.mutate({ kind: 'delete' }) })}><AppIcon name="trash" size={16} /> 삭제</button>
          </div>
        )}

        {/* 인벤토리 — 유일한 보기 */}
        {f && servers.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={sectionHead}>
              <span style={sectionLabel}>{matched.length}개 Mock</span>
              <span style={{ ...metaMono, marginLeft: 'auto' }}>{new Date(f.generatedAt).toLocaleTimeString()} 갱신 · 이름을 눌러 편집</span>
            </div>
            {!matched.length ? <div role="status" style={emptyBox}>조건에 맞는 Mock이 없습니다. <button onClick={() => { setQ(''); setFilter('all'); setKindFilter('all') }} style={miniBtn}>필터 초기화</button></div> : <MockInventory fleet={f} host={host} tenant={me?.tenant} match={matchActive ? match : null} sort={sort} pageNumber={catalog.view.page} pageSize={catalog.view.size} onPage={page => catalog.update({ page })} onSize={size => catalog.update({ size, page: 1 })} selected={selected} selectMode={selectMode} favs={favs}
              canEditGlobal={canEditGlobal} wsOptions={wsDestinations} onOpen={onOpen} onToggleSelect={onToggleSelect} onAction={onAction} onCreateIn={onCreateIn} />}
          </div>
        )}

        {f && servers.length === 0 && !creating && (
          <div style={emptyBox}>
            <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 18 }}>첫 Mock 서버를 만들어 보세요</div>
            <div style={{ color: 'var(--fl-text-muted)', fontSize: 14, marginTop: 6, maxWidth: 520, marginInline: 'auto' }}>
              <b>HTTP</b>는 이 공간 전용 URL에서 요청을 받고, <b>TCP</b>는 지정한 포트에서 전문을 받습니다. 이름과 응답 규칙을 정해 테스트를 시작하세요.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
              {canEditGlobal && <button onClick={() => { setCreating('HTTP'); setError(null) }} style={primaryBtn}>+ HTTP Mock</button>}
              {canEditGlobal && <button onClick={() => { setCreating('TCP'); setError(null) }} style={ghostBtn}>+ TCP Mock</button>}
              {canEditGlobal && <button onClick={() => setImporting(true)} style={ghostBtn}><AppIcon name="upload" size={16} /> 내보낸 JSON 가져오기</button>}
            </div>
          </div>
        )}
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      {importing && <MockImportDialog workspaceId={createLocation.id} api={mocksApi} onClose={() => setImporting(false)} onImported={() => invalidate()} />}
      {exporting && <MockExportDialog mock={exporting} onClose={() => setExporting(null)} />}
    </AppShellTier1>
  )
}

// ---------- 스타일 ----------
const metaMono: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', fontVariantNumeric: 'tabular-nums' }
const input: CSSProperties = { padding: '0 12px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 14, minWidth: 200 }
const selectStyle: CSSProperties = { padding: '8px 10px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer' }
const kindPill: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 38, padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', color: '#fff', fontWeight: 700, fontSize: 13 }
const createRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap', padding: 14, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const statusFilters: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 22, borderBottom: '1px solid var(--fl-border)' }
const statusFilter: CSSProperties = { border: 'none', borderBottom: '2px solid transparent', padding: '11px 13px', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 13, fontWeight: 650, cursor: 'pointer' }
const toolbar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }
const actionBar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, padding: '8px 12px', border: '1px solid color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))', borderRadius: 'var(--fl-radius-sm)', background: 'color-mix(in srgb, var(--fl-primary) 6%, var(--fl-surface))', flexWrap: 'wrap' }
const sectionHead: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 8, flexWrap: 'wrap' }
const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--fl-text)' }
const primaryBtn: CSSProperties = { ...ui.primary }
const ghostBtn: CSSProperties = { ...ui.secondary }
const miniBtn: CSSProperties = { ...ui.mini }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: '48px 40px', textAlign: 'center', color: 'var(--fl-text-muted)', marginTop: 24 }
