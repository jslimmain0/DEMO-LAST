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
type FilterKey = 'all' | 'on' | 'off' | 'live' | 'unmatched'
type Tab = 'HTTP' | 'TCP'

/**
 * Mock 대시보드 — **HTTP Mock | TCP Mock** 탭(섞이지 않음) · 현황 스트립(전체·서빙 중·요청 들어오는 중·무매칭 — 클릭=필터) ·
 * 최근 트래픽 · 2열 카드(라우트 미니 스트립 / TCP 포트·레이아웃·규칙) · 검색·정렬·즐겨찾기·선택 모드(일괄 켜기/끄기/삭제) · 사용처 워크플로 · ⋯ 메뉴.
 * 저장 즉시 /mock/{slug}/** (HTTP) 또는 포트 리스너(TCP)로 서빙(별도 프로세스 없음).
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
  const [tab, setTabRaw] = useState<Tab>(() => { try { return (localStorage.getItem('fl:mock:tab') as Tab) === 'TCP' ? 'TCP' : 'HTTP' } catch { return 'HTTP' } })
  const setTab = (t: Tab) => { setTabRaw(t); setFilter('all'); setSelected(new Set()); setSelectMode(false); setCreating(null); try { localStorage.setItem('fl:mock:tab', t) } catch { /* */ } }
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [creating, setCreating] = useState<Tab | null>(null)
  const [error, setError] = useState<string | null>(null)
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
    mutationFn: () => mocksApi.create({ name: name.trim() || slug.trim(), slug: slug.trim(), type: creating ?? 'HTTP', workspaceId: wsId === 'public' ? null : wsId }),
    onSuccess: (d) => { setName(''); setSlug(''); setError(null); setCreating(null); void invalidate(); navigate(`/mocks/${d.id}`) },
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
      const spec = d.spec?.tcp ? { ...d.spec, tcp: { ...d.spec.tcp, enabled: false } } : d.spec // TCP 포트 충돌 방지 — 리스너 꺼서 복제
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

  const all = servers.data ?? []
  const httpList = useMemo(() => all.filter((s) => s.kind !== 'TCP'), [all])
  const tcpList = useMemo(() => all.filter((s) => s.kind === 'TCP'), [all])
  const list = tab === 'TCP' ? tcpList : httpList
  const qq = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    let out = list.filter((s) => {
      if (filter === 'on' && !s.enabled) return false
      if (filter === 'off' && s.enabled) return false
      if (filter === 'live' && !((s.recentRequests ?? 0) > 0)) return false
      if (filter === 'unmatched' && !((s.unmatchedRequests ?? 0) > 0)) return false
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
  // 현황(현재 탭 기준)
  const stats = {
    total: list.length,
    on: list.filter((s) => s.enabled).length,
    live: list.filter((s) => (s.recentRequests ?? 0) > 0).length,
    unmatched: list.filter((s) => (s.unmatchedRequests ?? 0) > 0).length,
  }
  // 최근 트래픽 — 요청을 받은 Mock 을 마지막 요청 시각순으로(검색/필터 중엔 숨김)
  const recent = useMemo(() => [...list].filter((s) => s.lastRequestAt).sort((a, b) => (b.lastRequestAt ?? '').localeCompare(a.lastRequestAt ?? '')).slice(0, 5), [list])
  const isTcpTab = tab === 'TCP'

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '28px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>Mock 서버</h1>
              <span style={metaMono}>{all.length}</span>
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13.5, color: 'var(--fl-text-muted)', maxWidth: 620 }}>
              미완성 대상 시스템을 흉내 내는 가짜 서버. <b>HTTP</b> 는 경로마다 응답·조건 분기·콜백, <b>TCP</b> 는 포트에 고정길이 전문 — 워크플로 노드가 바로 호출합니다.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <select aria-label="워크스페이스" value={wsId} onChange={(e) => setWsId(e.target.value)} style={selectStyle}>
              {(wsOptions.length ? wsOptions : [{ id: 'public', name: '공용', kind: 'PUBLIC' } as WorkspaceView]).map((w) => (
                <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>
              ))}
            </select>
            {canEdit && <button onClick={() => setImporting(true)} style={ghostBtn} title="내보내기 JSON 을 붙여넣어 새 Mock 서버로">⬇ 가져오기</button>}
            {canEdit && <button onClick={() => { setCreating('HTTP'); setTabRaw('HTTP'); setError(null) }} style={{ ...primaryBtn, ...(creating === 'HTTP' ? { opacity: 0.6 } : null) }}>+ HTTP Mock</button>}
            {canEdit && <button onClick={() => { setCreating('TCP'); setTabRaw('TCP'); setError(null) }} style={{ ...primaryBtn, background: 'var(--fl-cat-tcp, #7c5cff)', ...(creating === 'TCP' ? { opacity: 0.6 } : null) }}>+ TCP Mock</button>}
          </div>
        </div>

        {/* 탭 — HTTP 는 HTTP 만, TCP 는 TCP 만 */}
        <div style={tabBar} role="tablist" aria-label="Mock 종류">
          {(['HTTP', 'TCP'] as Tab[]).map((t) => {
            const n = t === 'TCP' ? tcpList.length : httpList.length
            const live = (t === 'TCP' ? tcpList : httpList).filter((s) => (s.recentRequests ?? 0) > 0).length
            return (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} style={{ ...tabBtn, ...(tab === t ? tabOn : null) }}>
                {t === 'HTTP' ? '🌐 HTTP Mock' : '🔌 TCP Mock'} <span style={{ ...countBadge, ...(tab === t ? { background: 'var(--fl-primary)', color: '#fff', borderColor: 'transparent' } : null) }}>{n}</span>
                {live > 0 && <span aria-label={`요청 들어오는 중 ${live}`} style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--fl-ok)', marginLeft: 6, boxShadow: '0 0 0 3px color-mix(in srgb, var(--fl-ok) 25%, transparent)' }} />}
              </button>
            )
          })}
        </div>

        {creating && (
          <div style={createRow}>
            <span style={{ ...kindPill, background: creating === 'TCP' ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-primary)' }}>{creating === 'TCP' ? '🔌 TCP' : '🌐 HTTP'}</span>
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

        {/* 현황 스트립 — 클릭 = 필터 */}
        {list.length > 0 && (
          <div style={statsGrid} aria-label="현황">
            {([
              ['all', '전체', stats.total, 'var(--fl-text)', isTcpTab ? 'TCP Mock' : 'HTTP Mock'],
              ['on', isTcpTab ? '리스너 열림' : '서빙 중', stats.on, 'var(--fl-ok)', `${stats.total - stats.on}개 꺼짐`],
              ['live', '요청 들어오는 중', stats.live, 'var(--fl-ok)', '최근 60초'],
              ['unmatched', '무매칭 요청 있음', stats.unmatched, stats.unmatched ? 'var(--fl-fail)' : 'var(--fl-text-muted)', stats.unmatched ? '규칙이 없어 404/빈 응답' : '규칙 밖 요청 없음'],
            ] as Array<[FilterKey, string, number, string, string]>).map(([k, label, n, color, sub]) => (
              <button key={k} onClick={() => setFilter(filter === k ? 'all' : k)} aria-pressed={filter === k} style={{ ...statCard, ...(filter === k ? statOn : null) }} title={`클릭하면 ${label}만 보기`}>
                <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontWeight: 600 }}>{label}</span>
                <span style={{ fontSize: 24, fontWeight: 800, fontFamily: 'var(--fl-font-head)', color, lineHeight: 1.1 }}>{n}</span>
                <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{sub}</span>
              </button>
            ))}
          </div>
        )}

        {/* 최근 트래픽 */}
        {recent.length > 0 && !qq && filter === 'all' && !selectMode && (
          <div style={{ marginTop: 18 }}>
            <div style={sectionLabel}>⚡ 최근 트래픽</div>
            <div style={recentGrid}>
              {recent.map((s) => {
                const live = (s.recentRequests ?? 0) > 0
                return (
                  <button key={s.id} onClick={() => navigate(`/mocks/${s.id}`)} style={recentRow} title="열기">
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: live ? 'var(--fl-ok)' : 'var(--fl-border)', boxShadow: live ? '0 0 0 3px color-mix(in srgb, var(--fl-ok) 25%, transparent)' : undefined, flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{s.name}</span>
                    <span style={metaMono}>{relTime(s.lastRequestAt ?? '')}</span>
                    <span style={metaMono}>기록 {s.requestCount ?? 0}</span>
                    {(s.unmatchedRequests ?? 0) > 0 && <span style={{ ...metaMono, color: 'var(--fl-fail)', fontWeight: 700 }}>무매칭 {s.unmatchedRequests}</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 검색·정렬·필터·선택 — 대시보드 툴바 */}
        {list.length > 0 && (
          <div style={toolbar}>
            <span style={{ position: 'relative', flex: 1, minWidth: 220, display: 'inline-flex', alignItems: 'center' }}>
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur() } }}
                placeholder={isTcpTab ? '검색 — 이름 · slug · 포트   ( / )' : '검색 — 이름 · slug · 경로   ( / )'} aria-label="Mock 검색" style={{ ...input, width: '100%', minWidth: 0, paddingRight: q ? 30 : undefined }} />
              {q && <button onClick={() => setQ('')} aria-label="검색 지우기" style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 14 }}>×</button>}
            </span>
            <div style={segWrap} role="group" aria-label="필터">
              {([['all', '전체'], ['on', '켜짐'], ['off', '꺼짐']] as Array<[FilterKey, string]>).map(([k, label]) => (
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

        <div style={{ marginTop: 18 }}>
          {favList.length > 0 && <div style={sectionLabel}>★ 즐겨찾기</div>}
          {favList.length > 0 && <div style={cardGrid}>{favList.map((s) => cardOf(s))}</div>}
          {favList.length > 0 && restList.length > 0 && <div style={{ ...sectionLabel, marginTop: 14 }}>전체</div>}
          {restList.length > 0 && <div style={cardGrid}>{restList.map((s) => cardOf(s))}</div>}
          {servers.isSuccess && list.length === 0 && !creating && (
            <div style={emptyBox}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>{isTcpTab ? '첫 TCP Mock 을 만들어 보세요' : '첫 HTTP Mock 을 만들어 보세요'}</div>
              <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6, maxWidth: 480, marginInline: 'auto' }}>
                {isTcpTab
                  ? <>빈 포트에 고정길이 전문(길이 프리픽스) 리스너를 엽니다. 요청 레이아웃을 바이트 단위로 정의하고 규칙마다 응답 필드를 조립하면 워크플로 <b>TCP 전문</b> 노드가 바로 붙습니다.</>
                  : <>slug 를 정하면 <code style={codeChip}>/mock/&#123;slug&#125;/**</code> 로 즉시 서빙됩니다. 경로마다 응답·조건 분기·콜백·코덱을 정의하고, 워크플로 HTTP 노드가 바로 호출합니다.</>}
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
                {canEdit && <button onClick={() => { setCreating(tab); setError(null) }} style={{ ...primaryBtn, ...(isTcpTab ? { background: 'var(--fl-cat-tcp, #7c5cff)' } : null) }}>{isTcpTab ? '+ TCP Mock' : '+ HTTP Mock'}</button>}
                {canEdit && <button onClick={() => setImporting(true)} style={ghostBtn}>⬇ 내보낸 JSON 가져오기</button>}
                {(isTcpTab ? httpList.length : tcpList.length) > 0 && <button onClick={() => setTab(isTcpTab ? 'HTTP' : 'TCP')} style={ghostBtn}>{isTcpTab ? `HTTP Mock ${httpList.length}개 보기 →` : `TCP Mock ${tcpList.length}개 보기 →`}</button>}
              </div>
            </div>
          )}
          {servers.isSuccess && list.length > 0 && filtered.length === 0 && <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>검색/필터와 일치하는 Mock 이 없습니다. <button style={{ ...miniBtn, marginLeft: 6 }} onClick={() => { setFilter('all'); setQ('') }}>초기화</button></p>}
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
  const labels = s.routeLabels ?? []
  const moreRoutes = Math.max(0, (s.routeCount ?? 0) - labels.length)
  const unmatched = s.unmatchedRequests ?? 0
  return (
    <div className="fl-flow-card" role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      style={{ ...card, borderLeft: `3px solid ${s.enabled ? spine : 'var(--fl-border)'}`, cursor: 'pointer', ...(selected ? selectedCard : null) }}>
      {/* 꺼진 Mock 은 본문만 흐리게 — 카드 컨테이너에 opacity 를 주면 stacking context 가 생겨 ⋯ 메뉴가 다음 카드 뒤로 깔린다 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {selectMode && <input type="checkbox" checked={selected} onChange={onToggleSelect} onClick={(e) => e.stopPropagation()} aria-label={`${s.name} 선택`} style={cardCheckbox} />}
        <span aria-label={live ? `최근 60초 요청 ${s.recentRequests}건` : '최근 요청 없음'} title={live ? `최근 60초 요청 ${s.recentRequests}건 — 살아있음` : s.lastRequestAt ? `마지막 요청 ${relTime(s.lastRequestAt)}` : '아직 요청 없음'}
          style={{ width: 8, height: 8, borderRadius: 999, background: live ? 'var(--fl-ok)' : 'var(--fl-border)', boxShadow: live ? '0 0 0 3px color-mix(in srgb, var(--fl-ok) 25%, transparent)' : undefined, flexShrink: 0 }} />
        {fav && <span aria-label="즐겨찾기" style={{ color: 'var(--fl-put, #f5a623)', fontSize: 12 }}>★</span>}
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, opacity: s.enabled ? 1 : 0.7 }}>{s.name}</span>
        {!isTcp && s.tcpPort != null && <span style={chip} title="HTTP 라우트와 TCP 전문이 함께 있는 예전 형식 — 편집기에서 TCP Mock 으로 분리">레거시</span>}
        {s.hasCodec && <span style={chip} title="코덱 사용">◈ 코덱</span>}
        {s.environment && <span style={chip} title="시크릿 환경">🔑 {s.environment}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button disabled={readOnly} onClick={(e) => { e.stopPropagation(); onToggle() }} title={readOnly ? 'viewer 역할은 변경할 수 없습니다' : s.enabled ? (isTcp ? '리스너 열림 — 클릭하면 닫음' : '서빙 중 — 클릭하면 끔') : '꺼짐 — 클릭하면 켬'}
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
        </span>
      </div>

      <div style={{ opacity: s.enabled ? 1 : 0.7, minWidth: 0, display: 'grid', gap: 8 }}>
        {/* 주소 */}
        {isTcp ? (
          <span style={{ ...metaMono, fontSize: 12 }}>🔌 <b style={{ color: 'var(--fl-text)' }}>{s.tcpPort != null ? `:${s.tcpPort}` : '(포트 미설정)'}</b>{s.tcpEnabled === false ? ' · 리스너 꺼짐' : ''}</span>
        ) : (
          <button title="base URL 복사" onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(base).then(() => toast('base URL 복사됨', 'ok')).catch(() => {}) }}
            style={{ ...metaMono, display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', justifyContent: 'flex-start' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{base}</span> <span aria-hidden style={{ color: 'var(--fl-primary)' }}>⧉</span>
          </button>
        )}
        {/* 미니 스트립 — HTTP 라우트 / TCP 구성 */}
        {isTcp ? (
          <div style={strip} aria-label="TCP 구성">
            <span style={stripPill}><b>{s.tcpFieldCount ?? 0}</b> 요청 필드</span>
            <span style={stripPill}><b>{s.tcpRuleCount ?? 0}</b> 규칙</span>
            {s.hasCodec && <span style={stripPill}>◈ 전문 코덱</span>}
          </div>
        ) : labels.length > 0 ? (
          <div style={strip} aria-label="라우트">
            {labels.map((l, i) => {
              const sp = l.indexOf(' ')
              const m = sp > 0 ? l.slice(0, sp) : 'ANY'
              const p = sp > 0 ? l.slice(sp + 1) : l
              return (
                <span key={i} style={routePill} title={l}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-text-muted)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, color: METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-text-muted)', fontSize: 9.5 }}>{m}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{p}</span>
                </span>
              )
            })}
            {moreRoutes > 0 && <span style={{ ...routePill, color: 'var(--fl-text-muted)' }}>+{moreRoutes}</span>}
          </div>
        ) : (
          <div style={{ ...strip, color: 'var(--fl-text-muted)', fontSize: 11.5 }}>라우트 없음 — 열어서 만들거나 요청 기록에서 초안</div>
        )}
        {/* 푸터 메타 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={metaMono} title={s.lastRequestAt ? new Date(s.lastRequestAt).toLocaleString() : undefined}>
            {s.lastRequestAt ? `마지막 요청 ${relTime(s.lastRequestAt)} · 기록 ${s.requestCount ?? 0}` : '요청 기록 없음'}
          </span>
          {unmatched > 0 && <span style={{ ...metaMono, color: 'var(--fl-fail)', fontWeight: 700 }} title="규칙에 안 맞은 요청 — 편집기 트래픽 패널에서 [규칙 초안]">무매칭 {unmatched}</span>}
          <span ref={usesRef} style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            {usedBy.length > 0 ? (
              <button onClick={() => setUsesOpen((v) => !v)} style={{ ...chip, cursor: 'pointer', color: 'var(--fl-primary)', borderColor: 'color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))' }} title="이 Mock 의 base URL 을 쓰는 워크플로">↗ 워크플로 {usedBy.length}</button>
            ) : <span style={{ ...chip, opacity: 0.6 }} title={isTcp ? 'TCP 노드 사용처는 자동 감지하지 않음' : '현재 그래프에 이 Mock 의 base URL 이 있는 워크플로가 없음'}>사용처 없음</span>}
            {usesOpen && (
              <div role="menu" style={{ ...menuBox, top: 26, left: 0, right: 'auto', width: 240 }}>
                {usedBy.map((f) => <button key={f.id} role="menuitem" style={menuItem} onClick={() => navigate(`/flows/${f.id}`)}>↗ {f.name}</button>)}
              </div>
            )}
          </span>
          <span style={{ ...metaMono, marginLeft: 'auto' }} title={s.updatedAt ? new Date(s.updatedAt).toLocaleString() : undefined}>{(s.currentVersion ?? 0) > 0 ? `v${s.currentVersion} · ` : ''}{relTime(s.updatedAt ?? '') || ''}</span>
        </div>
      </div>
    </div>
  )
}

const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const input: CSSProperties = { padding: '0 12px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13.5, minWidth: 200 }
const selectStyle: CSSProperties = { padding: '8px 10px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const tabBar: CSSProperties = { display: 'flex', gap: 4, marginTop: 20, borderBottom: '1px solid var(--fl-border)' }
const tabBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', border: 'none', borderBottom: '2px solid transparent', marginBottom: -1, background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }
const tabOn: CSSProperties = { color: 'var(--fl-text)', borderBottomColor: 'var(--fl-primary)' }
const countBadge: CSSProperties = { fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const kindPill: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 38, padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', color: '#fff', fontWeight: 700, fontSize: 12.5 }
const createRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap', padding: 14, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const statsGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginTop: 18 }
const statCard: CSSProperties = { display: 'grid', gap: 3, textAlign: 'left', padding: '12px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer', boxShadow: 'var(--fl-shadow)' }
const statOn: CSSProperties = { borderColor: 'var(--fl-primary)', boxShadow: '0 0 0 2px color-mix(in srgb, var(--fl-primary) 30%, transparent)' }
const recentGrid: CSSProperties = { display: 'grid', gap: 4, marginTop: 6 }
const recentRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer', textAlign: 'left' }
const toolbar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }
const actionBar: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, padding: '8px 12px', border: '1px solid color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))', borderRadius: 'var(--fl-radius-sm)', background: 'color-mix(in srgb, var(--fl-primary) 6%, var(--fl-surface))', flexWrap: 'wrap' }
const segWrap: CSSProperties = { display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }
const segBtn: CSSProperties = { padding: '0 12px', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }
const segOn: CSSProperties = { background: 'var(--fl-primary)', color: '#fff' }
const sectionLabel: CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', marginBottom: 6 }
const cardGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(440px, 1fr))', gap: 12 }
const primaryBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 38, padding: '0 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13.5, cursor: 'pointer' }
const ghostBtn: CSSProperties = { height: 38, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const card: CSSProperties = { display: 'grid', gap: 10, padding: '14px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow)', minWidth: 0 }
const selectedCard: CSSProperties = { boxShadow: '0 0 0 2px var(--fl-primary), var(--fl-shadow)', background: 'var(--fl-surface-2)' }
const cardCheckbox: CSSProperties = { width: 18, height: 18, cursor: 'pointer', accentColor: 'var(--fl-primary)', flexShrink: 0 }
const pill: CSSProperties = { padding: '4px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface)', fontSize: 11.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const chip: CSSProperties = { fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', whiteSpace: 'nowrap' }
const strip: CSSProperties = { display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', padding: '7px 9px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', minHeight: 30, boxSizing: 'border-box' }
const routePill: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--fl-font-mono)', padding: '2px 8px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', maxWidth: '100%' }
const stripPill: CSSProperties = { fontSize: 11.5, padding: '2px 9px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: '48px 40px', textAlign: 'center', color: 'var(--fl-text-muted)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
const iconBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', color: 'var(--fl-text-muted)', fontSize: 15 }
const menuBox: CSSProperties = { position: 'absolute', top: 34, right: 0, width: 190, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 20, display: 'grid', gap: 2 }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const menuSelect: CSSProperties = { width: '100%', padding: '6px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
