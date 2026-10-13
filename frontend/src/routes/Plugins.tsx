import { PageHeader } from '../components/PageHeader'
import { AppIcon } from '../components/AppIcon'
import { useCentralApi, useWorkspace } from '../app/WorkspaceContext'
import { useUnsavedNavigation } from '../components/UnsavedNavigation'
import { registerEscapeClose } from '../components/useEscapeClose'
// 스크립트 플러그인 — 좌 목록 | 우 편집기(CodeMirror JS) + 실행 패널 + 상태 바. 초안 저장 → 승인 요청 → 관리자 승인 후 레지스트리.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import type { PluginKind, PluginScriptStatus, PluginScriptSummary, ScriptErrorBody } from '../api/types'
import { AppShellTier1 } from '../app/AppShell'
import { usePermissions } from '../auth/AuthContext'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import type { CodeEditorHandle, EditorDiagnostic } from '../components/CodeEditor'
import { PluginReference } from '../components/PluginReference'
import { PluginRunPanel } from '../components/PluginRunPanel'
import { PluginDiffView } from '../components/PluginDiffView'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'
import { declaredKeysSource, flCompletionSource } from '../lib/pluginCompletions'
import { PLUGIN_EXAMPLES, PLUGIN_TEMPLATES, kindLabel } from '../lib/pluginTemplates'
import { ui } from '../design/ui'
import './plugins.css'

const CodeEditorLazy = lazy(() => import('../components/CodeEditor'))

type Draft = { id: string | null; name: string; source: string }
const STATUS_LABEL: Record<PluginScriptStatus, string> = { DRAFT: '초안', PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '반려' }

function scriptError(e: unknown): ScriptErrorBody | null {
  const d = (e as { response?: { data?: Partial<ScriptErrorBody> } })?.response?.data
  return d && typeof d.message === 'string' && ('line' in d || 'col' in d) ? { message: d.message, line: d.line ?? null, col: d.col ?? null } : null
}

export function Plugins() {
  const { remoteKey } = useWorkspace()
  return <CentralPlugins key={remoteKey.replace(/:(?:true|false)$/, '')} />
}

function CentralPlugins() {
  const { adminApi, pluginsApi } = useCentralApi()
  const scope = useWorkspace()
  const spaceQuery = `?space=${encodeURIComponent(`${scope.current.origin}:${scope.current.id}`)}`

  const { id } = useParams()
  const [sp] = useSearchParams()
  const selection = id ?? `new:${sp.get('new') ?? ''}`
  const selectionRef = useRef(selection); selectionRef.current = selection
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { canEdit: permitted } = usePermissions()
  const resourceWorkspace = scope.workspaces.find(space => space.origin === 'server' && space.id === 'public')
  const canEdit = permitted && scope.connected && resourceWorkspace?.myRole !== 'VIEWER'
  const me = useQuery({ queryKey: ['admin', 'me', 'central', scope.remoteKey], queryFn: adminApi.me, staleTime: 30_000, enabled: scope.connected })
  const isAdmin = !!me.data?.admin
  const list = useQuery({ queryKey: ['plugins', 'scripts', 'central', scope.remoteKey], queryFn: () => pluginsApi.list(), refetchInterval: 15_000, enabled: scope.connected })
  const detail = useQuery({ queryKey: ['plugins', 'scripts', id, 'central', scope.remoteKey], queryFn: () => pluginsApi.get(id!), enabled: !!id && scope.connected })
  const manifest = useQuery({ queryKey: ['plugins', 'api', 'central', scope.remoteKey], queryFn: pluginsApi.api, staleTime: Infinity, enabled: scope.connected })

  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | PluginScriptStatus>('all')
  const [sort, setSort] = useState<PluginSort>(() => { try { const v = localStorage.getItem('fl.plugins.sort'); return v === 'name' || v === 'status' ? v : 'recent' } catch { return 'recent' } })
  const [wrap, setWrap] = useState(() => { try { return localStorage.getItem('fl.plugins.wrap') !== '0' } catch { return true } })
  const changeSort = (v: PluginSort) => { setSort(v); try { localStorage.setItem('fl.plugins.sort', v) } catch { /* 저장 불가 */ } }
  const toggleWrap = () => setWrap((v) => { try { localStorage.setItem('fl.plugins.wrap', v ? '0' : '1') } catch { /* 저장 불가 */ } return !v })
  const formatSource = () => {
    const r = editorRef.current?.format()
    if (r === 'fail') toast('코드를 정렬하지 못했습니다 — 문법 오류를 먼저 고쳐 주세요.', 'error')
    else if (r === 'noop') toast('이미 정렬된 코드입니다.', 'ok')
  }
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [diag, setDiag] = useState<EditorDiagnostic[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [listOpen, setListOpen] = useState(() => !window.matchMedia('(max-width:900px)').matches)
  const [panelOpen, setPanelOpen] = useState(false)
  const draftRef = useRef(draft); draftRef.current = draft
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const activeRef = useRef(true)
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false } }, [])
  const searchRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<CodeEditorHandle>(null)
  const getSource = useCallback(() => draftRef.current?.source ?? '', [])
  const changeSource = useCallback((source: string) => {
    if (!canEdit || !draftRef.current) return
    const next = { ...draftRef.current, source }
    draftRef.current = next; dirtyRef.current = true
    setDraft(next); setDirty(true)
  }, [canEdit])
  const previewSource = useDeferredValue(draft?.source ?? '')
  // 오른쪽 탭: 실행 | 레퍼런스 — 마지막 선택 기억(브라우저별)
  const [panel, setPanel] = useState<'run' | 'ref'>(() => { try { return localStorage.getItem('fl.plugins.panel') === 'ref' ? 'ref' : 'run' } catch { return 'run' } })
  const showRun = useCallback(() => { setPanel('run'); setPanelOpen(true) }, [])
  useEffect(() => { try { localStorage.setItem('fl.plugins.panel', panel) } catch { /* 저장 불가 환경 */ } }, [panel])

  // URL → 편집 상태: ?new=<kind|예제 key> 는 템플릿/예제 초안, /plugins/:id 는 서버 상세
  const newKind = sp.get('new')
  useEffect(() => {
    const src = (newKind && PLUGIN_TEMPLATES[newKind as PluginKind]?.source) || PLUGIN_EXAMPLES.find((x) => x.key === newKind)?.source
    if (src) { setDraft({ id: null, name: '', source: src }); setDirty(true); setDiag([]); setActionError(null) }
  }, [newKind])
  useEffect(() => {
    const d = detail.data
    if (!d) return
    const cur = draftRef.current
    // 같은 플러그인을 편집 중(dirty)이면 서버 재조회로 초안을 덮지 않는다 — 다른 플러그인으로 바뀌었거나 깨끗할 때만 재수화
    if (cur && cur.id === d.id && dirtyRef.current) return
    setDraft({ id: d.id, name: d.name, source: d.source }); setDirty(false); setDiag([]); setShowDiff(false); setActionError(null)
  }, [detail.data])

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['plugins', 'scripts'] }); void qc.invalidateQueries({ queryKey: ['admin', 'me'] }); void qc.invalidateQueries({ queryKey: ['transforms'] }); void qc.invalidateQueries({ queryKey: ['codecs'] }) }
  const onApiError = (e: unknown) => {
    const se = scriptError(e)
    setActionError(se ? `${se.line ? `${se.line}행: ` : ''}${se.message}` : apiErrorMessage(e))
    if (se) { setDiag(se.line ? [{ line: se.line, col: se.col ?? undefined, message: se.message }] : []); toast(`${se.line ? `${se.line}행: ` : ''}${se.message}`, 'error') }
    else toast(apiErrorMessage(e), 'error')
  }

  const save = useMutation({
    onMutate: () => { setActionError(null); return selectionRef.current },
    mutationFn: async () => {
      const d = draftRef.current!
      const snapshot = structuredClone(d)
      const selected = selectionRef.current
      const saved = snapshot.id ? await pluginsApi.update(snapshot.id, { name: snapshot.name || undefined, source: snapshot.source }) : await pluginsApi.create({ name: snapshot.name || undefined, source: snapshot.source })
      return { saved, snapshot, selected }
    },
    onSuccess: ({ saved, snapshot, selected }) => {
      const current = draftRef.current
      if (!activeRef.current || !current || current.id !== snapshot.id || selectionRef.current !== selected) return
      const unchanged = current.name === snapshot.name && current.source === snapshot.source
      dirtyRef.current = !unchanged
      setDirty(!unchanged); setDiag([]); invalidate(); toast(unchanged ? '저장됨(초안)' : '이전 변경은 저장됐습니다. 추가 편집을 저장하세요.', 'ok')
      if (!snapshot.id) {
        const next = { ...current, id: saved.id }; draftRef.current = next; setDraft(next)
        navigateSaved(`/plugins/${saved.id}${spaceQuery}`, { replace: true })
      }
      else void qc.invalidateQueries({ queryKey: ['plugins', 'scripts', saved.id] })
    },
    onError: (e, _variables, selected) => { if (activeRef.current && selectionRef.current === selected) onApiError(e) },
  })
  const { navigateSaved } = useUnsavedNavigation({ dirty, saving: save.isPending, label: '플러그인 소스' })
  const transition = useMutation({
    onMutate: () => { setActionError(null); return selectionRef.current },
    mutationFn: ({ op, note, targetId }: { op: 'submit' | 'withdraw' | 'approve' | 'reject' | 'remove'; note?: string; targetId: string }) =>
      op === 'submit' ? pluginsApi.submit(targetId) : op === 'withdraw' ? pluginsApi.withdraw(targetId) : op === 'approve' ? pluginsApi.approve(targetId)
      : op === 'reject' ? pluginsApi.reject(targetId, note ?? '') : pluginsApi.remove(targetId).then(() => null),
    onSuccess: (_r, v, selected) => {
      invalidate()
      if (!activeRef.current || selectionRef.current !== selected || draftRef.current?.id !== v.targetId) return
      if (v.op === 'remove') { setDirty(false); toast('삭제됨', 'ok'); navigateSaved(`/plugins${spaceQuery}`) }
      else { toast({ submit: '승인 요청함', withdraw: '철회함', approve: '승인됨 — 즉시 서빙', reject: '반려함' }[v.op], 'ok'); void qc.invalidateQueries({ queryKey: ['plugins', 'scripts', id] }) }
    },
    onError: (e, _variables, selected) => { if (activeRef.current && selectionRef.current === selected) onApiError(e) },
  })

  // Ctrl+S 저장(편집기 안에서도) · 미저장 이탈 경고
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.isComposing || e.keyCode === 229) return; if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); if (dirtyRef.current && canEdit && !save.isPending && !transition.isPending && !ask && (!id || draftRef.current?.id === id)) save.mutate() } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [dirty, canEdit, save, transition.isPending, id, ask])
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h)
  }, [dirty])
  // '/' 로 검색 포커스(입력 중이 아닐 때만)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable
      if (!typing && e.key === '/') { e.preventDefault(); searchRef.current?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const completions = useMemo(() => [flCompletionSource(manifest.data ?? []), declaredKeysSource(() => draftRef.current?.source ?? '')], [manifest.data])
  const items = useMemo(() => {
    const t = q.trim().toLowerCase()
    const rows = (list.data ?? []).filter((p) => (statusFilter === 'all' || p.status === statusFilter) && (!t || `${p.name} ${p.pluginId} ${p.kind}`.toLowerCase().includes(t)))
    return [...rows].sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'ko')
      : sort === 'status' ? (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name, 'ko')
      : (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }, [list.data, q, statusFilter, sort])
  const d = detail.data
  const visibleDraft = draft && (id ? draft.id === id : !!newKind) ? draft : null
  const status: PluginScriptStatus | null = d?.status ?? null
  const openNew = (kind: string) => navigate(`/plugins${spaceQuery}&new=${encodeURIComponent(kind)}`)
  const select = useCallback((pid: string) => { navigate(`/plugins/${pid}${spaceQuery}`); if (window.matchMedia('(max-width:900px)').matches) setListOpen(false) }, [navigate, spaceQuery])
  const listedItems = useMemo(() => items.map(p => <ListItem key={p.id} p={p} on={p.id === id} onClick={() => select(p.id)} />), [items, id, select])

  return (
    <AppShellTier1>
      <div className="fl-plugin-workbench" data-list-open={listOpen}>
        {/* ── 좌 목록 ── */}
        <aside style={listPane} aria-label="플러그인 목록">
          <PageHeader title="플러그인" count={list.data?.length ?? 0} description="서버 · 공통 자원" />
          {!scope.connected && <p role="status" style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>서버에 연결하면 공통 플러그인을 볼 수 있습니다.</p>}
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색 — 이름·id ( / )" aria-label="플러그인 검색" style={search}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fl-text-muted)' }}>상태<select aria-label="플러그인 상태" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)} style={{ flex: 1, minWidth: 0 }}>{(['all', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED'] as const).map(value => <option key={value} value={value}>{value === 'all' ? '전체' : STATUS_LABEL[value]}</option>)}</select></label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fl-text-muted)' }}>
            정렬
            <select value={sort} onChange={(e) => changeSort(e.target.value as PluginSort)} aria-label="목록 정렬" style={{ flex: 1, minWidth: 0 }}>
              <option value="recent">최근 수정순</option>
              <option value="name">이름순</option>
              <option value="status">상태순</option>
            </select>
          </label>
          {canEdit && (
            <div style={{ display: 'grid', gap: 4 }}>
              {(Object.keys(PLUGIN_TEMPLATES) as PluginKind[]).map((k) => (
                <button key={k} onClick={() => openNew(k)} style={newBtn} title={PLUGIN_TEMPLATES[k].label}>+ 새 {kindLabel(k)}</button>
              ))}
              <select value="" aria-label="예제에서 시작" onChange={(e) => { if (e.target.value) openNew(e.target.value) }} style={{ ...newBtn, padding: '6px 8px' }}>
                <option value="">예제에서 시작…</option>
                {PLUGIN_EXAMPLES.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </div>
          )}
          <div style={{ overflowY: 'auto', display: 'grid', gap: 3, alignContent: 'start' }}>
            {list.isLoading && <div style={muted}>불러오는 중…</div>}
            {list.isError && <div role="alert" style={muted}>목록을 불러오지 못했습니다. <button style={ghostBtn} onClick={() => void list.refetch()}>다시 불러오기</button></div>}
            {list.data && !items.length && <div style={muted}>{q ? '일치하는 플러그인이 없습니다.' : '아직 플러그인이 없습니다 — 위에서 새로 만드세요.'}</div>}
            {listedItems}
          </div>
        </aside>

        {/* ── 우 편집기 ── */}
        <div className="fl-plugin-detail">
          <div className="fl-plugin-workspace-tools"><button style={ghostBtn} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}><AppIcon name="list" size={15} />{listOpen ? '목록 접기' : '플러그인 목록'}</button></div>
          {id && detail.isLoading && !visibleDraft ? <div role="status" style={empty}>플러그인을 불러오는 중…</div>
          : id && detail.isError && !visibleDraft ? <div role="alert" style={empty}><p>{apiErrorMessage(detail.error, '플러그인을 불러오지 못했습니다.')}</p><button style={ghostBtn} onClick={() => void detail.refetch()}>다시 불러오기</button></div>
          : !visibleDraft ? (
            <div style={empty}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 18 }}>스크립트 플러그인</div>
              <p style={{ maxWidth: 560, margin: '8px 0 0', fontSize: 14, lineHeight: 1.65 }}>
                JS 로 변환·코덱을 적고 → 오른쪽에서 돌려 보고 → 승인 요청하면 관리자가 코드와 샘플 결과를 보고 승인합니다. 승인된 플러그인은 TRANSFORM 노드·Mock 코덱·프로토콜에서 바로 고를 수 있습니다.
              </p>
            </div>
          ) : (
            <>
              <header className="fl-plugin-heading" style={hdr}>
                <div className="fl-plugin-heading-info">
                <input value={visibleDraft.name} onChange={(e) => { const next = { ...draftRef.current!, name: e.target.value }; draftRef.current = next; dirtyRef.current = true; setDraft(next); setDirty(true) }} placeholder={d?.meta?.label || '플러그인 이름'} aria-label="플러그인 이름" disabled={!canEdit || transition.isPending}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }} style={nameInput} />
                {d && <span style={metaMono}>#{d.pluginId} · {kindLabel(d.kind)}</span>}
                {status && <StatusPill status={status} live={!!d?.live} dirtyLive={!!d?.dirty} />}
                {d?.reviewNote && status === 'REJECTED' && <span style={{ fontSize: 12, color: 'var(--fl-fail)' }} title={d.reviewNote}>반려 사유: {d.reviewNote}</span>}
                {dirty && <span style={{ fontSize: 12, color: 'var(--fl-waiting)' }}>● 저장 안 됨</span>}
                </div>
                <div className="fl-plugin-actions" role="group" aria-label="플러그인 작업">
                  {d && <UsagesChip id={d.id} count={d.usages} />}
                  {d?.live && <button style={ghostBtn} onClick={() => setShowDiff((v) => !v)}>{showDiff ? '편집으로' : '승인본과 비교'}</button>}
                  {canEdit && <button style={{ ...primaryBtn, opacity: dirty ? 1 : 0.55 }} disabled={!dirty || save.isPending || transition.isPending} onClick={() => save.mutate()} title="Ctrl+S"><AppIcon name="save" size={16} />{save.isPending ? '저장 중…' : '저장'}</button>}
                  <button style={panelOpen && panel === 'run' ? primaryBtn : ghostBtn} aria-expanded={panelOpen && panel === 'run'} title="테스트 입력과 결과 패널 열기 · 실제 실행은 패널에서 합니다." onClick={() => { setPanel('run'); setPanelOpen(!(panelOpen && panel === 'run')) }}>테스트 패널</button>
                  <button style={panelOpen && panel === 'ref' ? primaryBtn : ghostBtn} aria-expanded={panelOpen && panel === 'ref'} onClick={() => { setPanel('ref'); setPanelOpen(!(panelOpen && panel === 'ref')) }}>API 참고</button>
                  {canEdit && (!d || status === 'DRAFT' || status === 'REJECTED' || (status === 'APPROVED' && (d.dirty || dirty))) && (
                    <button style={okBtn} disabled={!d || dirty || transition.isPending || save.isPending} title={!d || dirty ? '변경 내용을 먼저 저장한 뒤 승인 요청하세요.' : '저장된 초안과 테스트 샘플을 검토받습니다.'} onClick={() => { if (dirtyRef.current) { toast('변경 내용을 먼저 저장하세요.', 'error'); return } transition.mutate({ op: 'submit', targetId: id! }) }}>승인 요청</button>
                  )}
                  {canEdit && status === 'PENDING' && <button style={ghostBtn} disabled={transition.isPending || save.isPending} onClick={() => transition.mutate({ op: 'withdraw', targetId: id! })}>철회</button>}
                  {isAdmin && status === 'PENDING' && (
                    <>
                      <button style={okBtn} disabled={transition.isPending || save.isPending} onClick={() => transition.mutate({ op: 'approve', targetId: id! })}>✓ 승인</button>
                      <button style={dangerBtn} disabled={transition.isPending || save.isPending} onClick={() => setAsk({ title: '반려 사유', input: { label: '사유', placeholder: '무엇을 고쳐야 하는지' }, confirmLabel: '반려', danger: true, onConfirm: (v) => transition.mutate({ op: 'reject', note: v, targetId: id! }) })}>반려</button>
                    </>
                  )}
                  {canEdit && d && <button style={dangerBtn} disabled={transition.isPending || save.isPending || d.usages > 0} title={d.usages > 0 ? `사용 중(${d.usages}곳)이라 삭제할 수 없습니다` : '삭제'}
                    onClick={() => setAsk({ title: `'${d.name}' 삭제`, message: d.live ? '승인본도 함께 사라지고 서빙이 중단됩니다.' : undefined, confirmLabel: '삭제', danger: true, onConfirm: () => transition.mutate({ op: 'remove', targetId: id! }) })}>삭제</button>}
                </div>
                {canEdit && dirty && <p style={{ color: 'var(--fl-text-muted)', fontSize: 12, margin: 0, lineHeight: 1.6 }}>현재 코드로 테스트할 수 있습니다. 승인 요청은 변경 내용을 저장한 뒤 진행하세요.</p>}
                {actionError && <p role="alert" style={{ color: 'var(--fl-fail)', fontSize: 12, margin: 0, lineHeight: 1.6, overflowWrap: 'anywhere' }}>{actionError} 입력은 유지됩니다. 수정 후 다시 시도하세요.</p>}
                {detail.isError && <p role="alert" style={{ color: 'var(--fl-fail)', fontSize: 12, margin: 0 }}>저장된 상태를 다시 확인하지 못했습니다. 편집 중인 입력은 유지됩니다. <button style={ghostBtn} onClick={() => void detail.refetch()}>다시 불러오기</button></p>}
              </header>
              <div className="fl-plugin-stage" data-panel-open={panelOpen}>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid var(--fl-border)' }}>
                  {showDiff && d?.liveSource ? (
                    <PluginDiffView before={d.liveSource} after={visibleDraft.source} />
                  ) : (
                    <Suspense fallback={<textarea value={visibleDraft.source} aria-label="플러그인 소스 코드 불러오는 중" readOnly style={{ flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 13, padding: 14, border: 'none' }} />}>
                      <CodeEditorLazy ref={editorRef} value={visibleDraft.source} language="javascript" completions={completions} diagnostics={diag} wrap={wrap} readOnly={!canEdit || transition.isPending} ariaLabel="플러그인 소스 코드"
                        onChange={changeSource} />
                    </Suspense>
                  )}
                  <div style={statusBar}>
                    <button type="button" onClick={formatSource} disabled={!canEdit || showDiff} style={barBtn} title="코드 정렬 (Shift+Alt+F)">정렬</button>
                    <button type="button" onClick={toggleWrap} aria-pressed={wrap} style={{ ...barBtn, ...(wrap ? barBtnOn : null) }} title="긴 줄을 화면 폭에서 접어 보기">줄바꿈 {wrap ? '켜짐' : '꺼짐'}</button>
                    <span style={{ alignSelf: 'center' }}>Ctrl+S 저장 · Ctrl+Enter 실행 · <code>fl.</code> 자동완성</span>
                    {d?.updatedAt && <span style={{ marginLeft: 'auto' }}>수정 {relTime(d.updatedAt)} · {d.createdBy}</span>}
                  </div>
                </div>
                <div className="fl-plugin-support" style={{ display: panelOpen ? 'grid' : 'none', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: 0, minWidth: 0 }}>
                  <div role="tablist" style={tabs}>
                    <button role="tab" aria-selected={panel === 'run'} style={{ ...tab, ...(panel === 'run' ? tabOn : null) }} onClick={() => setPanel('run')}>테스트 입력·결과</button>
                    <button role="tab" aria-selected={panel === 'ref'} style={{ ...tab, ...(panel === 'ref' ? tabOn : null) }} onClick={() => setPanel('ref')}>API 참고</button>
                    <button style={tab} aria-label="보조 패널 닫기" onClick={() => setPanelOpen(false)}><AppIcon name="close" size={16} /></button>
                  </div>
                  {/* 둘 다 마운트 유지(실행 패널의 입력값·결과가 탭 전환에 안 날아가게) — 보이는 쪽만 grid */}
                  <div style={{ display: panel === 'run' ? 'grid' : 'none', gridTemplateRows: 'minmax(0, 1fr)', minHeight: 0 }}>
                    <PluginRunPanel source={panelOpen && panel === 'run' ? previewSource : ''} getSource={getSource} active={panelOpen && panel === 'run'} onRunStart={showRun} scriptId={d?.id ?? null} canRun={canEdit} onDiagnostics={setDiag} />
                  </div>
                  <div style={{ display: panel === 'ref' ? 'grid' : 'none', gridTemplateRows: 'minmax(0, 1fr)', minHeight: 0 }}>
                    {panelOpen && panel === 'ref' && <PluginReference manifest={manifest.data ?? []} source={previewSource} canInsert={canEdit && !showDiff} onInsert={(text) => { if (!canEdit || showDiff) return; editorRef.current?.insert(text) }} />}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </AppShellTier1>
  )
}

function ListItem({ p, on, onClick }: { p: PluginScriptSummary; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on} style={{ ...item, ...(on ? itemOn : null) }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'flex-start', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={p.name}>{p.name}</span>
        <StatusPill status={p.status} live={p.live} dirtyLive={p.dirty} small />
      </span>
      <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', overflowWrap: 'anywhere' }}>{p.pluginId} · {kindLabel(p.kind)}{p.usages ? ` · ${p.usages}곳` : ''}</span>
    </button>
  )
}

/** 상태 필 — 승인본 서빙 중이면 초록 점, 승인본과 다르게 수정 중이면 "수정 중". */
function StatusPill({ status, live, dirtyLive, small }: { status: PluginScriptStatus; live: boolean; dirtyLive: boolean; small?: boolean }) {
  const color = status === 'APPROVED' ? 'var(--fl-ok)' : status === 'PENDING' ? 'var(--fl-waiting)' : status === 'REJECTED' ? 'var(--fl-fail)' : 'var(--fl-text-muted)'
  const label = status === 'APPROVED' && dirtyLive ? '수정 중' : STATUS_LABEL[status]
  return (
    <span title={live ? '승인본 서빙 중' : '아직 서빙되지 않음'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: small ? 10.5 : 11.5, fontWeight: 700, color, padding: small ? '0 6px' : '2px 8px', border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, borderRadius: 999, whiteSpace: 'nowrap' }}>
      {live && <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fl-ok)' }} />}{label}
    </span>
  )
}

/** 사용처 N — 클릭하면 목록 팝오버(항목 클릭 = 해당 화면). */
function UsagesChip({ id, count }: { id: string; count: number }) {
  const { pluginsApi } = useCentralApi()
  const { remoteKey } = useWorkspace()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const navigate = useNavigate()
  const refs = useQuery({ queryKey: ['plugins', 'scripts', id, 'central', remoteKey, 'usages'], queryFn: () => pluginsApi.usages(id), enabled: open })
  useEffect(() => { if (open) return registerEscapeClose(() => { setOpen(false); trigger.current?.focus() }) }, [open])
  return (
    <span style={{ position: 'relative' }}>
      <button ref={trigger} aria-expanded={open} style={{ ...ghostBtn, opacity: count ? 1 : 0.6 }} onClick={() => setOpen((v) => !v)} title="이 플러그인을 쓰는 워크플로·Mock·프로토콜">사용처 {count}</button>
      {open && (
        <div role="region" aria-label="플러그인 사용처" className="fl-plugin-usages-popover" style={pop}>
          {refs.isLoading && <div style={muted}>불러오는 중…</div>}
          {refs.isError && <div role="alert" style={muted}>사용처를 불러오지 못했습니다. <button style={ghostBtn} onClick={() => void refs.refetch()}>다시 불러오기</button></div>}
          {refs.data?.length === 0 && <div style={muted}>사용처 없음</div>}
          {refs.data?.map((r, index) => (
            <button key={`${r.kind}-${r.id}-${index}`} disabled={!r.id} style={{ ...item, ...(!r.id ? { cursor: 'default', color: 'var(--fl-text-muted)' } : {}) }} onClick={() => { if (r.id) { setOpen(false); navigate(r.kind === 'flow' ? `/flows/${r.id}` : r.kind === 'mock' ? `/mocks/${r.id}` : `/protocols/${r.id}`) } }}>
              <span style={{ fontSize: 13 }}>{r.kind === 'flow' ? '▤' : r.kind === 'mock' ? '◈' : '⫶'} {r.name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

const listPane: CSSProperties = { gridTemplateRows: 'auto auto auto auto auto 1fr', gap: 8, padding: '18px 14px', borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', minHeight: 0, minWidth: 0 }
const search: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, minWidth: 0, width: '100%', boxSizing: 'border-box' }
const newBtn: CSSProperties = { ...ui.secondary, textAlign: 'left', color: 'var(--fl-primary)', minWidth: 0, width: '100%' }
const item: CSSProperties = { display: 'grid', gap: 2, textAlign: 'left', padding: '8px 10px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', minWidth: 0, width: '100%' }
const itemOn: CSSProperties = { background: 'var(--fl-surface-2)', borderColor: 'var(--fl-border)' }
const muted: CSSProperties = { fontSize: 13, color: 'var(--fl-text-muted)', padding: '6px 2px' }
const empty: CSSProperties = { display: 'grid', alignContent: 'start', justifyItems: 'start', textAlign: 'left', color: 'var(--fl-text-soft)', padding: '48px 56px', maxWidth: 680 }
const hdr: CSSProperties = { padding: '10px 16px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)', flexShrink: 0 }
const nameInput: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 16, border: '1px solid transparent', background: 'transparent', color: 'var(--fl-text)', padding: '4px 6px', borderRadius: 6, minWidth: 0, maxWidth: '100%', flex: '1 1 180px' }
const metaMono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const tabs: CSSProperties = { display: 'flex', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }
const tab: CSSProperties = { flex: 1, padding: '8px 10px', border: 'none', borderBottom: '2px solid transparent', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 13, cursor: 'pointer' }
const tabOn: CSSProperties = { color: 'var(--fl-text)', fontWeight: 700, borderBottom: '2px solid var(--fl-primary)' }
const statusBar: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '4px 8px', borderTop: '1px solid var(--fl-border)', fontSize: 11, color: 'var(--fl-text-muted)', background: 'var(--fl-surface)' }
const primaryBtn: CSSProperties = { ...ui.primary }
const barBtn: CSSProperties = { ...ui.ghost, minHeight: 24, padding: '0 8px', fontSize: 11, fontWeight: 600, color: 'var(--fl-text-soft)' }
const barBtnOn: CSSProperties = { background: 'var(--fl-surface-2)', color: 'var(--fl-text)' }
type PluginSort = 'recent' | 'name' | 'status'
const STATUS_ORDER: PluginScriptStatus[] = ['PENDING', 'DRAFT', 'REJECTED', 'APPROVED']
const okBtn: CSSProperties = { ...primaryBtn, background: 'var(--fl-ok)' }
const dangerBtn: CSSProperties = { ...ui.danger }
const ghostBtn: CSSProperties = { ...ui.secondary }
const pop: CSSProperties = { position: 'absolute', top: 'calc(100% + 4px)', zIndex: 60, minWidth: 240, padding: 6, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow-lg)', display: 'grid', gap: 2 }
