import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HttpMethod, MockFlowRef, MockServerDetail, MockServerSummary } from '../api/types'
import { mockBaseUrl, mocksApi, workspacesApi } from '../api/client'
import type { WorkspaceView } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { MockExportDialog, MockImportDialog } from '../components/MockTransferDialog'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'

type SortKey = 'updated' | 'name' | 'traffic'
type FilterKey = 'all' | 'on' | 'off' | 'HTTP' | 'TCP'

/**
 * Mock 서버 목록 — 워크플로 대시보드급: 검색(이름·slug·경로)·정렬·필터·즐겨찾기·선택 모드(일괄 켜기/끄기/삭제)·
 * 카드 요약(메서드 칩·라우트 수·TCP 포트·코덱·시크릿 환경)·살아있음 점(최근 60초 요청)·사용처 워크플로·⋯ 메뉴.
 * 저장 즉시 /mock/{slug}/** 로 서빙(별도 프로세스 없음).
 */
export function MockServers() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { canEdit: canEditGlobal } = usePermissions()
  const { me } = useAuth()

  // 워크스페이스 스코프 — 대시보드와 같은 선택(fl:workspace) 공유. Mock 도 flow 와 동일 규약으로 분리.
  const [wsId, setWsIdRaw] = useState<string>(() => { try { return localStorage.getItem('fl:workspace') ?? 'public' } catch { return 'public' } })
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: workspacesApi.list })
  const setWsId = (id: string) => {
    setWsIdRaw(id)
    try { localStorage.setItem('fl:workspace', id) } catch { /* 프라이빗 모드 */ }
    setSelected(new Set()); setSelectMode(false)
  }
  useEffect(() => {
    if (workspaces.data && !workspaces.isFetching && !workspaces.data.some((w) => w.id === wsId)) {
      setWsIdRaw('public')
      try { localStorage.setItem('fl:workspace', 'public') } catch { /* 프라이빗 모드 */ }
    }
  }, [workspaces.data, workspaces.isFetching, wsId])
  const wsRole = workspaces.data?.find((w) => w.id === wsId)?.myRole ?? 'EDITOR'
  const canEdit = canEditGlobal && wsRole !== 'VIEWER'

  // 목록은 5초 폴링 — 살아있음 점(최근 60초 요청)·요청 수가 움직인다
  const servers = useQuery({ queryKey: ['mock-servers', wsId], queryFn: () => mocksApi.list(wsId), refetchInterval: 5000 })
  const usages = useQuery({ queryKey: ['mock-usages', wsId], queryFn: () => mocksApi.usages(wsId), refetchInterval: 30000, retry: false })
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [type, setType] = useState<'HTTP' | 'TCP'>('HTTP')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState<MockServerDetail | null>(null)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>(() => { try { return (localStorage.getItem('fl:mock:sort') as SortKey) || 'updated' } catch { return 'updated' } })
  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)

  // 즐겨찾기 — 워크스페이스별 localStorage(개인 취향)
  const favKey = `fl:mockfav:${wsId}`
  const [favs, setFavs] = useState<Set<string>>(new Set())
  useEffect(() => { try { setFavs(new Set(JSON.parse(localStorage.getItem(favKey) ?? '[]') as string[])) } catch { setFavs(new Set()) } }, [favKey])
  const toggleFav = (id: string) => {
    setFavs((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); try { localStorage.setItem(favKey, JSON.stringify([...n])) } catch { /* */ } return n })
  }

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['mock-servers'] }); qc.invalidateQueries({ queryKey: ['mock-usages'] }) }

  const create = useMutation({
    mutationFn: () => mocksApi.create({ name: name.trim() || slug.trim(), slug: slug.trim(), type, workspaceId: wsId === 'public' ? null : wsId }),
    onSuccess: (d) => { setName(''); setSlug(''); setType('HTTP'); setError(null); setCreating(false); void invalidate(); navigate(`/mocks/${d.id}`) },
    onError: (e) => setError(apiErrorMessage(e)),
  })
  const toggle = useMutation({ mutationFn: (s: MockServerSummary) => mocksApi.update(s.id, { enabled: !s.enabled }), onSuccess: invalidate, onError: (e) => toast(apiErrorMessage(e, '변경 실패'), 'error') })
  const remove = useMutation({ mutationFn: (id: string) => mocksApi.remove(id), onSuccess: invalidate, onError: (e) => toast(apiErrorMessage(e, '삭제 실패'), 'error') })
  const rename = useMutation({ mutationFn: (v: { id: string; name: string }) => mocksApi.update(v.id, { name: v.name }), onSuccess: () => { invalidate(); toast('이름을 바꿨습니다.', 'ok') }, onError: (e) => toast(apiErrorMessage(e, '이름 변경 실패'), 'error') })
  const move = useMutation({ mutationFn: (v: { id: string; workspaceId: string }) => mocksApi.update(v.id, { workspaceId: v.workspaceId }), onSuccess: () => { invalidate(); toast('워크스페이스를 옮겼습니다.', 'ok') }, onError: (e) => toast(apiErrorMessage(e, '이동 실패'), 'error') })
  const duplicate = useMutation({
    mutationFn: async (s: MockServerSummary) => {
      const d = await mocksApi.get(s.id)
      let n = 2; let candidate = `${s.slug}-${n}`.slice(0, 40)
      for (; n < 30; n++) { candidate = `${s.slug.slice(0, 40 - String(n).length - 1)}-${n}`; if ((await mocksApi.slugCheck(candidate)).available) break }
      const created = await mocksApi.create({ name: `${s.name} (복제)`, slug: candidate, type: s.kind === 'TCP' ? 'TCP' : 'HTTP', workspaceId: wsId === 'public' ? null : wsId })
      const spec = d.spec?.tcp ? { ...d.spec, tcp: { ...d.spec.tcp, enabled: false } } : d.spec // TCP 포트 충돌 방지 — 꺼서 복제
      await mocksApi.updateSpec(created.id, spec ?? { routes: [] }, { note: `${s.slug} 복제` })
      return created
    },
    onSuccess: (d) => { invalidate(); toast(`'${d.name}' 으로 복제했습니다(slug ${d.slug}).`, 'ok') },
    onError: (e) => toast(apiErrorMessage(e, '복제 실패'), 'error'),
  })
  const bulk = useMutation({
    mutationFn: async (op: 'on' | 'off' | 'delete') => {
      const ids = [...selected]
      for (const id of ids) { if (op === 'delete') await mocksApi.remove(id); else await mocksApi.update(id, { enabled: op === 'on' }) }
      return ids.length
    },
    onSuccess: (n, op) => { invalidate(); setSelected(new Set()); toast(`${n}개 ${op === 'delete' ? '삭제' : op === 'on' ? '켜기' : '끄기'} 완료`, 'ok') },
    onError: (e) => { invalidate(); toast(apiErrorMessage(e, '일괄 작업 실패'), 'error') },
  })

  const list = servers.data ?? []
  const qq = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    let out = list.filter((s) => {
      if (filter === 'on' && !s.enabled) return false
      if (filter === 'off' && s.enabled) return false
      if ((filter === 'HTTP' || filter === 'TCP') && s.kind !== filter && !(filter === 'HTTP' && s.kind === 'CUSTOM')) return false
      if (!qq) return true
      const hay = `${s.name} ${s.slug} ${(s.paths ?? []).join(' ')} ${s.tcpPort ?? ''}`.toLowerCase()
      return hay.includes(qq)
    })
    out = [...out].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'ko')
      if (sort === 'traffic') return (b.recentRequests ?? 0) - (a.recentRequests ?? 0) || (b.requestCount ?? 0) - (a.requestCount ?? 0) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    })
    return out
  }, [list, qq, filter, sort])
  const favList = filtered.filter((s) => favs.has(s.id))
  const restList = filtered.filter((s) => !favs.has(s.id))
  const slugFormatOk = /^[a-z0-9-]{3,40}$/.test(slug.trim())

  // slug 실시간 가용성 — 서빙 주소(/mock/{slug})가 워크스페이스 무관 전역이라 겹치면 제출 전에 알려준다
  const [slugTaken, setSlugTaken] = useState<boolean | null>(null)
  useEffect(() => {
    setSlugTaken(null)
    if (!slugFormatOk) return
    const t = setTimeout(() => { mocksApi.slugCheck(slug.trim()).then((r) => setSlugTaken(!r.available)).catch(() => setSlugTaken(null)) }, 350)
    return () => clearTimeout(t)
  }, [slug, slugFormatOk])
  const slugOk = slugFormatOk && slugTaken !== true

  // 단축키: / 또는 Ctrl+F 검색 포커스(입력 중 제외), Esc 검색 지우기/선택 해제
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

  const wsOptions = workspaces.data ?? []
  const liveCount = list.filter((s) => (s.recentRequests ?? 0) > 0).length

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>Mock 서버</h1>
              <span style={metaMono}>{list.length}</span>
              {liveCount > 0 && <span style={{ ...metaMono, color: 'var(--fl-ok)' }} title="최근 60초 안에 요청을 받은 Mock">● 요청 들어오는 중 {liveCount}</span>}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--fl-text-muted)', maxWidth: 560 }}>
              미완성 시스템을 흉내 내는 가짜 API. 경로마다 응답·조건 분기·콜백·전문 코덱을 정의하면 워크플로 노드가 바로 호출합니다.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select aria-label="워크스페이스" value={wsId} onChange={(e) => setWsId(e.target.value)} style={selectStyle}>
              {(wsOptions.length ? wsOptions : [{ id: 'public', name: '공용', kind: 'PUBLIC' } as WorkspaceView]).map((w) => (
                <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>
              ))}
            </select>
            {canEdit && <button onClick={() => setImporting(true)} style={ghostBtn} title="내보내기 JSON 을 붙여넣어 새 Mock 서버로">⬇ 가져오기</button>}
            {!creating && canEdit && <button onClick={() => setCreating(true)} style={primaryBtn}>+ 새 Mock 서버</button>}
          </div>
        </div>

        {creating && (
          <div style={createRow}>
            <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }}>
              {(['HTTP', 'TCP'] as const).map((t) => (
                <button key={t} onClick={() => setType(t)} title={t === 'HTTP' ? '경로·응답·콜백' : '포트·고정길이 전문'}
                  style={{ padding: '0 14px', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--fl-font-mono)', background: type === t ? 'var(--fl-primary)' : 'transparent', color: type === t ? '#fff' : 'var(--fl-text-muted)' }}>{t}</button>
              ))}
            </div>
            <input style={input} placeholder="이름 (예: 결제 게이트웨이)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input style={{ ...input, fontFamily: 'var(--fl-font-mono)', paddingRight: 84, borderColor: slugTaken === true ? 'var(--fl-fail)' : undefined }}
                placeholder="slug (예: pay-mock)" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} onKeyDown={(e) => { if (e.key === 'Enter' && slugOk) create.mutate() }} />
              {slugFormatOk && slugTaken !== null && (
                <span style={{ position: 'absolute', right: 10, fontSize: 11, fontWeight: 700, pointerEvents: 'none', color: slugTaken ? 'var(--fl-fail)' : 'var(--fl-ok)' }}>{slugTaken ? '✕ 사용 중' : '✓ 사용 가능'}</span>
              )}
            </span>
            <button style={{ ...primaryBtn, opacity: slugOk ? 1 : 0.5 }} disabled={!slugOk || create.isPending} onClick={() => create.mutate()}>만들기</button>
            <button style={ghostBtn} onClick={() => { setCreating(false); setError(null) }}>취소</button>
            <span style={{ flexBasis: '100%', fontSize: 11.5, color: 'var(--fl-text-muted)' }}>{type === 'HTTP' ? 'HTTP: 경로마다 JSON/HTML/XML 응답·조건 분기·콜백 발사' : 'TCP: 빈 포트에 고정길이 전문(길이 프리픽스) 리스너 — 워크플로 TCP 노드 대상'} · slug 는 서빙 주소(/mock/{'{slug}'})라 워크스페이스와 무관하게 전체에서 유일해야 합니다</span>
          </div>
        )}
        {error && <p style={{ color: 'var(--fl-fail)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}

        {/* 검색·정렬·필터·선택 — 대시보드 툴바 */}
        {list.length > 0 && (
          <div style={toolbar}>
            <span style={{ position: 'relative', flex: 1, minWidth: 220, display: 'inline-flex', alignItems: 'center' }}>
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() } }}
                placeholder="검색 — 이름 · slug · 경로 · 포트   ( / )" aria-label="Mock 검색" style={{ ...input, width: '100%', minWidth: 0, paddingRight: q ? 30 : undefined }} />
              {q && <button onClick={() => setQ('')} aria-label="검색 지우기" style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 14 }}>×</button>}
            </span>
            <div style={segWrap} role="group" aria-label="필터">
              {([['all', '전체'], ['on', '켜짐'], ['off', '꺼짐'], ['HTTP', 'HTTP'], ['TCP', 'TCP']] as Array<[FilterKey, string]>).map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k)} style={{ ...segBtn, ...(filter === k ? segOn : null) }}>{label}</button>
              ))}
            </div>
            <select aria-label="정렬" value={sort} onChange={(e) => { setSort(e.target.value as SortKey); try { localStorage.setItem('fl:mock:sort', e.target.value) } catch { /* */ } }} style={selectStyle}>
              <option value="updated">최근 수정순</option>
              <option value="name">이름순</option>
              <option value="traffic">요청 많은 순</option>
            </select>
            {canEdit && <button onClick={() => { setSelectMode((v) => !v); setSelected(new Set()) }} style={{ ...ghostBtn, ...(selectMode ? { borderColor: 'var(--fl-primary)', color: 'var(--fl-primary)' } : null) }} title="여러 Mock 을 골라 한 번에 켜기/끄기/삭제">{selectMode ? '선택 취소' : '☑ 선택'}</button>}
          </div>
        )}
        {selectMode && (
          <div style={actionBar}>
            <span style={{ fontSize: 12.5 }}>{selected.size}개 선택</span>
            <button style={miniBtn} onClick={() => setSelected(new Set(filtered.map((s) => s.id)))}>모두 선택</button>
            <button style={miniBtn} disabled={!selected.size || bulk.isPending} onClick={() => bulk.mutate('on')}>● 켜기</button>
            <button style={miniBtn} disabled={!selected.size || bulk.isPending} onClick={() => bulk.mutate('off')}>○ 끄기</button>
            <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} disabled={!selected.size || bulk.isPending}
              onClick={() => setAsk({ title: 'Mock 서버 일괄 삭제', danger: true, confirmLabel: `${selected.size}개 삭제`, message: `선택한 ${selected.size}개 Mock 서버를 삭제할까요? 되돌릴 수 없습니다.`, onConfirm: () => bulk.mutate('delete') })}>🗑 삭제</button>
          </div>
        )}

        <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
          {favList.length > 0 && <div style={sectionLabel}>★ 즐겨찾기</div>}
          {favList.map((s) => cardOf(s))}
          {favList.length > 0 && restList.length > 0 && <div style={sectionLabel}>전체</div>}
          {restList.map((s) => cardOf(s))}
          {servers.isSuccess && list.length === 0 && !creating && (
            <div style={emptyBox}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>첫 Mock 서버를 만들어 보세요</div>
              <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6, maxWidth: 460, marginInline: 'auto' }}>
                slug 를 정하면 <code style={codeChip}>/mock/&#123;slug&#125;/**</code> 로 즉시 서빙됩니다. 경로마다 응답·조건 분기·콜백·전문 코덱을 정의하고, 워크플로 HTTP/TCP 노드가 바로 호출합니다.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
                {canEdit && <button onClick={() => setCreating(true)} style={primaryBtn}>+ 새 Mock 서버</button>}
                {canEdit && <button onClick={() => setImporting(true)} style={ghostBtn}>⬇ 내보낸 JSON 가져오기</button>}
              </div>
            </div>
          )}
          {servers.isSuccess && list.length > 0 && filtered.length === 0 && <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>검색/필터와 일치하는 Mock 이 없습니다.</p>}
        </div>
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      {importing && <MockImportDialog workspaceId={wsId === 'public' ? null : wsId} onClose={() => setImporting(false)} onImported={() => void invalidate()} />}
      {exporting && <MockExportDialog mock={exporting} onClose={() => setExporting(null)} />}
    </AppShellTier1>
  )

  function cardOf(s: MockServerSummary) {
    return (
      <MockCard key={s.id} server={s} tenant={me?.tenant} readOnly={!canEdit} usedBy={usages.data?.[s.id] ?? []}
        selectMode={selectMode} selected={selected.has(s.id)} fav={favs.has(s.id)}
        wsOptions={wsOptions}
        onToggleSelect={() => setSelected((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n })}
        onToggle={() => toggle.mutate(s)}
        onFav={() => toggleFav(s.id)}
        onRename={() => setAsk({ title: '이름 바꾸기', input: { label: '이름', initial: s.name }, confirmLabel: '변경', onConfirm: (v) => rename.mutate({ id: s.id, name: v }) })}
        onDuplicate={() => duplicate.mutate(s)}
        onMove={(target) => move.mutate({ id: s.id, workspaceId: target })}
        onExport={async () => { try { setExporting(await mocksApi.get(s.id)) } catch (e) { toast(apiErrorMessage(e, '불러오기 실패'), 'error') } }}
        onRemove={() => setAsk({ title: 'Mock 서버 삭제', danger: true, confirmLabel: '삭제', message: `'${s.name}' Mock 서버를 삭제할까요? 되돌릴 수 없습니다.${(usages.data?.[s.id]?.length ?? 0) ? ` 이 Mock 을 쓰는 워크플로 ${usages.data![s.id].length}개가 호출에 실패하게 됩니다.` : ''}`, onConfirm: () => remove.mutate(s.id) })} />
    )
  }
}

function MockCard({ server: s, tenant, readOnly, usedBy, selectMode, selected, fav, wsOptions, onToggleSelect, onToggle, onFav, onRename, onDuplicate, onMove, onExport, onRemove }: {
  server: MockServerSummary; tenant?: string | null; readOnly?: boolean; usedBy: MockFlowRef[]
  selectMode: boolean; selected: boolean; fav: boolean; wsOptions: WorkspaceView[]
  onToggleSelect: () => void; onToggle: () => void; onFav: () => void; onRename: () => void; onDuplicate: () => void
  onMove: (workspaceId: string) => void; onExport: () => void; onRemove: () => void
}) {
  const navigate = useNavigate()
  const [menu, setMenu] = useState(false)
  const [usesOpen, setUsesOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const usesRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!menu && !usesOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || usesRef.current?.contains(t)) return
      setMenu(false); setUsesOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(false); setUsesOpen(false) } }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [menu, usesOpen])
  const isTcp = s.kind === 'TCP'
  const live = (s.recentRequests ?? 0) > 0
  const spine = isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-http, var(--fl-primary))'
  const open = () => (selectMode ? onToggleSelect() : navigate(`/mocks/${s.id}`))
  const base = mockBaseUrl(s.slug, tenant)
  return (
    <div className="fl-flow-card" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      style={{ ...card, borderLeft: `3px solid ${s.enabled ? spine : 'var(--fl-border)'}`, cursor: 'pointer', ...(selected ? selectedCard : null) }}>
      {selectMode && <input type="checkbox" checked={selected} onChange={onToggleSelect} onClick={(e) => e.stopPropagation()} aria-label={`${s.name} 선택`} style={cardCheckbox} />}
      {/* 꺼진 Mock 은 본문만 흐리게 — 카드 컨테이너에 opacity 를 주면 stacking context 가 생겨 ⋯ 메뉴가 다음 카드 뒤로 깔린다 */}
      <div style={{ minWidth: 0, flex: 1, opacity: s.enabled ? 1 : 0.7 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span aria-label={live ? `최근 60초 요청 ${s.recentRequests}건` : '최근 요청 없음'} title={live ? `최근 60초 요청 ${s.recentRequests}건 — 살아있음` : s.lastRequestAt ? `마지막 요청 ${relTime(s.lastRequestAt)}` : '아직 요청 없음'}
            style={{ width: 8, height: 8, borderRadius: 999, background: live ? 'var(--fl-ok)' : 'var(--fl-border)', boxShadow: live ? '0 0 0 3px color-mix(in srgb, var(--fl-ok) 25%, transparent)' : undefined, flexShrink: 0 }} />
          {fav && <span aria-label="즐겨찾기" style={{ color: 'var(--fl-put, #f5a623)', fontSize: 12 }}>★</span>}
          <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15, color: 'var(--fl-text)' }}>{s.name}</span>
          {s.kind !== 'CUSTOM' && <span style={{ ...kindBadge, color: isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-primary)' }}>{s.kind}</span>}
          {s.hasCodec && <span style={chip} title="전문 코덱 사용">코덱</span>}
          {s.environment && <span style={chip} title="시크릿 환경">🔑 {s.environment}</span>}
          {(s.currentVersion ?? 0) > 0 && <span style={{ ...metaMono, marginLeft: 2 }}>v{s.currentVersion}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, minWidth: 0, flexWrap: 'wrap' }}>
          {isTcp ? (
            <span style={metaMono}>{s.tcpPort != null ? `TCP :${s.tcpPort}${s.tcpEnabled === false ? ' (리스너 꺼짐)' : ''}` : 'TCP (포트 미설정)'}</span>
          ) : (
            <button title="base URL 복사" onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(base).then(() => toast('base URL 복사됨', 'ok')).catch(() => {}) }}
              style={{ ...metaMono, display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>
              {base} <span aria-hidden style={{ color: 'var(--fl-primary)' }}>⧉</span>
            </button>
          )}
          {!isTcp && (s.methods ?? []).length > 0 && (
            <span style={{ display: 'inline-flex', gap: 3 }}>
              {(s.methods ?? []).map((m) => <span key={m} style={{ ...methodChip, color: METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-text-muted)', borderColor: 'color-mix(in srgb, ' + (METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-border)') + ' 45%, var(--fl-border))' }}>{m}</span>)}
            </span>
          )}
          {!isTcp && s.routeCount != null && <span style={metaMono}>라우트 {s.routeCount}</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={metaMono} title={s.lastRequestAt ? new Date(s.lastRequestAt).toLocaleString() : undefined}>
            {s.lastRequestAt ? `마지막 요청 ${relTime(s.lastRequestAt)} · 기록 ${s.requestCount ?? 0}` : '요청 기록 없음'}
          </span>
          <span ref={usesRef} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            {usedBy.length > 0 ? (
              <button onClick={() => setUsesOpen((v) => !v)} style={{ ...chip, cursor: 'pointer', color: 'var(--fl-primary)', borderColor: 'color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))' }} title="이 Mock 의 base URL 을 쓰는 워크플로">↗ 워크플로 {usedBy.length}</button>
            ) : <span style={{ ...chip, opacity: 0.6 }} title="현재 그래프에 이 Mock 의 base URL 이 있는 워크플로가 없음">사용처 없음</span>}
            {usesOpen && (
              <div role="menu" style={{ ...menuBox, top: 26, left: 0, right: 'auto', width: 240 }}>
                {usedBy.map((f) => <button key={f.id} role="menuitem" style={menuItem} onClick={() => navigate(`/flows/${f.id}`)}>↗ {f.name}</button>)}
              </div>
            )}
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={metaMono} title={s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined}>{relTime(s.updatedAt ?? '') || ''}</span>
        <button disabled={readOnly} onClick={(e) => { e.stopPropagation(); onToggle() }} title={readOnly ? 'viewer 역할은 변경할 수 없습니다' : s.enabled ? '서빙 중 — 클릭하면 끔' : '꺼짐 — 클릭하면 켬'}
          style={{ ...pill, opacity: readOnly ? 0.5 : 1, color: s.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', borderColor: s.enabled ? 'color-mix(in srgb, var(--fl-ok) 40%, var(--fl-border))' : 'var(--fl-border)' }}>
          {s.enabled ? '● 켜짐' : '○ 꺼짐'}
        </button>
        {!selectMode && (
          <div ref={menuRef} onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
            <button onClick={() => setMenu((v) => !v)} aria-label={`${s.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu} title="작업" style={iconBtn}>⋯</button>
            {menu && (
              <div role="menu" style={menuBox}>
                <button role="menuitem" style={menuItem} onClick={() => { onFav(); setMenu(false) }}>{fav ? '☆ 즐겨찾기 해제' : '★ 즐겨찾기'}</button>
                {!readOnly && <button role="menuitem" style={menuItem} onClick={() => { onRename(); setMenu(false) }}>✎ 이름 바꾸기</button>}
                {!readOnly && <button role="menuitem" style={menuItem} onClick={() => { onDuplicate(); setMenu(false) }}>⧉ 복제</button>}
                <button role="menuitem" style={menuItem} onClick={() => { void onExport(); setMenu(false) }}>⬆ 내보내기</button>
                {!readOnly && wsOptions.length > 1 && (
                  <>
                    <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--fl-text-muted)' }}>워크스페이스로 이동</div>
                    <select aria-label="워크스페이스 이동" value={s.workspaceId ?? 'public'} onChange={(e) => { onMove(e.target.value); setMenu(false) }} style={menuSelect}>
                      {wsOptions.filter((w) => w.myRole !== 'VIEWER').map((w) => <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>)}
                    </select>
                  </>
                )}
                {!readOnly && <button role="menuitem" style={{ ...menuItem, color: 'var(--fl-fail)' }} onClick={() => { onRemove(); setMenu(false) }}>🗑 삭제</button>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const input: CSSProperties = { padding: '0 12px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13.5, minWidth: 200 }
const selectStyle: CSSProperties = { padding: '8px 10px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const createRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 20, flexWrap: 'wrap', padding: 14, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const toolbar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 20, flexWrap: 'wrap' }
const actionBar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, padding: '8px 12px', border: '1px solid color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))', borderRadius: 'var(--fl-radius-sm)', background: 'color-mix(in srgb, var(--fl-primary) 6%, var(--fl-surface))', flexWrap: 'wrap' }
const segWrap: CSSProperties = { display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }
const segBtn: CSSProperties = { padding: '0 12px', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }
const segOn: CSSProperties = { background: 'var(--fl-primary)', color: '#fff' }
const sectionLabel: CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', marginTop: 6 }
const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' }
const ghostBtn: CSSProperties = { height: 38, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const card: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow)' }
const selectedCard: CSSProperties = { boxShadow: '0 0 0 2px var(--fl-primary), var(--fl-shadow)', background: 'var(--fl-surface-2)' }
const cardCheckbox: CSSProperties = { width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--fl-primary)', flexShrink: 0 }
const pill: CSSProperties = { padding: '5px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', fontSize: 12, cursor: 'pointer' }
const chip: CSSProperties = { fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)' }
const methodChip: CSSProperties = { fontSize: 9.5, fontWeight: 800, fontFamily: 'var(--fl-font-mono)', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--fl-border)' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: '48px 40px', textAlign: 'center', color: 'var(--fl-text-muted)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
const kindBadge: CSSProperties = { fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--fl-font-mono)', padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor' }
const iconBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', color: 'var(--fl-text-muted)', fontSize: 15 }
const menuBox: CSSProperties = { position: 'absolute', top: 34, right: 0, width: 190, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 20, display: 'grid', gap: 2 }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const menuSelect: CSSProperties = { width: '100%', padding: '6px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
