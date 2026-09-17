// 스크립트 플러그인 — 좌 목록 | 우 편집기(CodeMirror JS) + 실행 패널 + 상태 바. 초안 저장 → 승인 요청 → 관리자 승인 후 레지스트리.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { adminApi, pluginsApi } from '../api/client'
import type { PluginKind, PluginScriptDetail, PluginScriptStatus, PluginScriptSummary, ScriptErrorBody } from '../api/types'
import { AppShellTier1 } from '../app/AppShell'
import { usePermissions } from '../auth/AuthContext'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import type { EditorDiagnostic } from '../components/CodeEditor'
import { PluginRunPanel } from '../components/PluginRunPanel'
import { PluginDiffView } from '../components/PluginDiffView'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'
import { declaredKeysSource, flCompletionSource } from '../lib/pluginCompletions'
import { PLUGIN_TEMPLATES, kindLabel } from '../lib/pluginTemplates'

const CodeEditorLazy = lazy(() => import('../components/CodeEditor'))

type Draft = { id: string | null; name: string; source: string }
const STATUS_LABEL: Record<PluginScriptStatus, string> = { DRAFT: '초안', PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '반려' }

function scriptError(e: unknown): ScriptErrorBody | null {
  const d = (e as { response?: { data?: Partial<ScriptErrorBody> } })?.response?.data
  return d && typeof d.message === 'string' && ('line' in d || 'col' in d) ? { message: d.message, line: d.line ?? null, col: d.col ?? null } : null
}

export function Plugins() {
  const { id } = useParams()
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { canEdit } = usePermissions()
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000 })
  const isAdmin = !!me.data?.admin
  const list = useQuery({ queryKey: ['plugins', 'scripts'], queryFn: () => pluginsApi.list(), refetchInterval: 15_000 })
  const detail = useQuery({ queryKey: ['plugins', 'scripts', id], queryFn: () => pluginsApi.get(id!), enabled: !!id })
  const manifest = useQuery({ queryKey: ['plugins', 'api'], queryFn: pluginsApi.api, staleTime: Infinity })

  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | PluginScriptStatus>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [diag, setDiag] = useState<EditorDiagnostic[]>([])
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const draftRef = useRef(draft); draftRef.current = draft
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const searchRef = useRef<HTMLInputElement>(null)

  // URL → 편집 상태: ?new=<kind> 는 템플릿 초안, /plugins/:id 는 서버 상세
  const newKind = sp.get('new') as PluginKind | null
  useEffect(() => {
    if (newKind && PLUGIN_TEMPLATES[newKind]) { setDraft({ id: null, name: '', source: PLUGIN_TEMPLATES[newKind].source }); setDirty(true); setDiag([]) }
  }, [newKind])
  useEffect(() => {
    const d = detail.data
    if (!d) return
    const cur = draftRef.current
    // 같은 플러그인을 편집 중(dirty)이면 서버 재조회로 초안을 덮지 않는다 — 다른 플러그인으로 바뀌었거나 깨끗할 때만 재수화
    if (cur && cur.id === d.id && dirtyRef.current) return
    setDraft({ id: d.id, name: d.name, source: d.source }); setDirty(false); setDiag([]); setShowDiff(false)
  }, [detail.data])

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['plugins', 'scripts'] }); void qc.invalidateQueries({ queryKey: ['admin', 'me'] }); void qc.invalidateQueries({ queryKey: ['transforms'] }); void qc.invalidateQueries({ queryKey: ['codecs'] }) }
  const onApiError = (e: unknown) => {
    const se = scriptError(e)
    if (se) { setDiag(se.line ? [{ line: se.line, col: se.col ?? undefined, message: se.message }] : []); toast(`${se.line ? `${se.line}행: ` : ''}${se.message}`, 'error') }
    else toast(apiErrorMessage(e), 'error')
  }

  const save = useMutation({
    mutationFn: async () => {
      const d = draftRef.current!
      return d.id ? pluginsApi.update(d.id, { name: d.name || undefined, source: d.source }) : pluginsApi.create({ name: d.name || undefined, source: d.source })
    },
    onSuccess: (saved: PluginScriptDetail) => {
      setDirty(false); setDiag([]); invalidate(); toast('저장됨(초안)', 'ok')
      if (!draftRef.current?.id) { setSp({}); navigate(`/plugins/${saved.id}`, { replace: true }) }
      else void qc.invalidateQueries({ queryKey: ['plugins', 'scripts', saved.id] })
    },
    onError: onApiError,
  })
  const transition = useMutation({
    mutationFn: ({ op, note }: { op: 'submit' | 'withdraw' | 'approve' | 'reject' | 'remove'; note?: string }) =>
      op === 'submit' ? pluginsApi.submit(id!) : op === 'withdraw' ? pluginsApi.withdraw(id!) : op === 'approve' ? pluginsApi.approve(id!)
      : op === 'reject' ? pluginsApi.reject(id!, note ?? '') : pluginsApi.remove(id!).then(() => null),
    onSuccess: (_r, v) => {
      invalidate()
      if (v.op === 'remove') { toast('삭제됨', 'ok'); navigate('/plugins') }
      else { toast({ submit: '승인 요청함', withdraw: '철회함', approve: '승인됨 — 즉시 서빙', reject: '반려함' }[v.op], 'ok'); void qc.invalidateQueries({ queryKey: ['plugins', 'scripts', id] }) }
    },
    onError: onApiError,
  })

  // Ctrl+S 저장(편집기 안에서도) · 미저장 이탈 경고
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); if (dirty && canEdit && !save.isPending) save.mutate() } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [dirty, canEdit, save])
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
    return (list.data ?? []).filter((p) => (statusFilter === 'all' || p.status === statusFilter) && (!t || `${p.name} ${p.pluginId} ${p.kind}`.toLowerCase().includes(t)))
  }, [list.data, q, statusFilter])
  const d = detail.data
  const status: PluginScriptStatus | null = d?.status ?? null
  const openNew = (kind: PluginKind) => { if (dirty && !confirm('저장하지 않은 변경이 있습니다. 새로 만들까요?')) return; navigate(`/plugins?new=${kind}`) }
  const select = (pid: string) => { if (dirty && !confirm('저장하지 않은 변경이 있습니다. 이동할까요?')) return; setSp({}); navigate(`/plugins/${pid}`) }

  return (
    <AppShellTier1>
      <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', height: '100vh', minHeight: 0 }}>
        {/* ── 좌 목록 ── */}
        <aside style={listPane} aria-label="플러그인 목록">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>◇ 플러그인</strong>
            <span style={muted}>{list.data?.length ?? 0}</span>
          </div>
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색 — 이름·id ( / )" aria-label="플러그인 검색" style={search}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['all', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{ ...chip, ...(statusFilter === s ? chipOn : null) }}>{s === 'all' ? '전체' : STATUS_LABEL[s]}</button>
            ))}
          </div>
          {canEdit && (
            <div style={{ display: 'grid', gap: 4 }}>
              {(Object.keys(PLUGIN_TEMPLATES) as PluginKind[]).map((k) => (
                <button key={k} onClick={() => openNew(k)} style={newBtn} title={PLUGIN_TEMPLATES[k].label}>+ 새 {kindLabel(k)}</button>
              ))}
            </div>
          )}
          <div style={{ overflowY: 'auto', display: 'grid', gap: 3, alignContent: 'start' }}>
            {list.isLoading && <div style={muted}>불러오는 중…</div>}
            {list.data && !items.length && <div style={muted}>{q ? '일치하는 플러그인이 없습니다.' : '아직 플러그인이 없습니다 — 위에서 새로 만드세요.'}</div>}
            {items.map((p) => <ListItem key={p.id} p={p} on={p.id === id} onClick={() => select(p.id)} />)}
          </div>
        </aside>

        {/* ── 우 편집기 ── */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!draft ? (
            <div style={empty}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>스크립트 플러그인</div>
              <p style={{ maxWidth: 520, margin: '8px auto 0', fontSize: 13.5, lineHeight: 1.6 }}>
                JS 로 변환·코덱을 적고 → 오른쪽에서 돌려 보고 → 승인 요청하면 관리자가 코드와 샘플 결과를 보고 승인합니다. 승인된 플러그인은 TRANSFORM 노드·Mock 코덱·프로토콜에서 바로 고를 수 있습니다.
              </p>
            </div>
          ) : (
            <>
              <header style={hdr}>
                <input value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setDirty(true) }} placeholder={d?.meta?.label || '플러그인 이름'} aria-label="플러그인 이름" disabled={!canEdit}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }} style={nameInput} />
                {d && <span style={metaMono}>#{d.pluginId} · {kindLabel(d.kind)}</span>}
                {status && <StatusPill status={status} live={!!d?.live} dirtyLive={!!d?.dirty} />}
                {d?.reviewNote && status === 'REJECTED' && <span style={{ fontSize: 12, color: 'var(--fl-fail)' }} title={d.reviewNote}>반려 사유: {d.reviewNote}</span>}
                {dirty && <span style={{ fontSize: 11.5, color: 'var(--fl-waiting)' }}>● 저장 안 됨</span>}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {d && <UsagesChip id={d.id} count={d.usages} />}
                  {d?.live && <button style={ghostBtn} onClick={() => setShowDiff((v) => !v)}>{showDiff ? '편집으로' : '승인본과 비교'}</button>}
                  {canEdit && <button style={{ ...primaryBtn, opacity: dirty ? 1 : 0.55 }} disabled={!dirty || save.isPending} onClick={() => save.mutate()} title="Ctrl+S">💾 저장</button>}
                  {canEdit && d && (status === 'DRAFT' || status === 'REJECTED' || (status === 'APPROVED' && d.dirty)) && !dirty && (
                    <button style={okBtn} disabled={transition.isPending} onClick={() => transition.mutate({ op: 'submit' })}>승인 요청</button>
                  )}
                  {canEdit && status === 'PENDING' && <button style={ghostBtn} disabled={transition.isPending} onClick={() => transition.mutate({ op: 'withdraw' })}>철회</button>}
                  {isAdmin && status === 'PENDING' && (
                    <>
                      <button style={okBtn} disabled={transition.isPending} onClick={() => transition.mutate({ op: 'approve' })}>✓ 승인</button>
                      <button style={dangerBtn} disabled={transition.isPending} onClick={() => setAsk({ title: '반려 사유', input: { label: '사유', placeholder: '무엇을 고쳐야 하는지' }, confirmLabel: '반려', danger: true, onConfirm: (v) => transition.mutate({ op: 'reject', note: v }) })}>반려</button>
                    </>
                  )}
                  {canEdit && d && <button style={dangerBtn} disabled={transition.isPending || d.usages > 0} title={d.usages > 0 ? `사용 중(${d.usages}곳)이라 삭제할 수 없습니다` : '삭제'}
                    onClick={() => setAsk({ title: `'${d.name}' 삭제`, message: d.live ? '승인본도 함께 사라지고 서빙이 중단됩니다.' : undefined, confirmLabel: '삭제', danger: true, onConfirm: () => transition.mutate({ op: 'remove' }) })}>삭제</button>}
                </span>
              </header>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', minHeight: 0 }}>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid var(--fl-border)' }}>
                  {showDiff && d?.liveSource ? (
                    <PluginDiffView before={d.liveSource} after={draft.source} />
                  ) : (
                    <Suspense fallback={<textarea value={draft.source} readOnly style={{ flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 13, padding: 14, border: 'none' }} />}>
                      <CodeEditorLazy value={draft.source} language="javascript" completions={completions} diagnostics={diag} wrap={false}
                        onChange={(v) => { if (!canEdit) return; setDraft((x) => (x ? { ...x, source: v } : x)); setDirty(true) }} />
                    </Suspense>
                  )}
                  <div style={statusBar}>
                    <span>Ctrl+S 저장 · Ctrl+Enter 실행 · Shift+Alt+F 정렬 · <code>fl.</code> 자동완성</span>
                    {d?.updatedAt && <span style={{ marginLeft: 'auto' }}>수정 {relTime(d.updatedAt)} · {d.createdBy}</span>}
                  </div>
                </div>
                <PluginRunPanel source={draft.source} scriptId={d?.id ?? null} canRun={canEdit} onDiagnostics={setDiag} />
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
    <button onClick={onClick} style={{ ...item, ...(on ? itemOn : null) }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.name}</span>
        <StatusPill status={p.status} live={p.live} dirtyLive={p.dirty} small />
      </span>
      <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{p.pluginId} · {kindLabel(p.kind)}{p.usages ? ` · ${p.usages}곳` : ''}</span>
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
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const refs = useQuery({ queryKey: ['plugins', 'scripts', id, 'usages'], queryFn: () => pluginsApi.usages(id), enabled: open })
  return (
    <span style={{ position: 'relative' }}>
      <button style={{ ...ghostBtn, opacity: count ? 1 : 0.6 }} onClick={() => setOpen((v) => !v)} title="이 플러그인을 쓰는 워크플로·Mock·프로토콜">사용처 {count}</button>
      {open && (
        <div role="menu" style={pop} onMouseLeave={() => setOpen(false)}>
          {refs.isLoading && <div style={muted}>불러오는 중…</div>}
          {refs.data?.length === 0 && <div style={muted}>사용처 없음</div>}
          {refs.data?.map((r) => (
            <button key={`${r.kind}-${r.id}`} style={item} onClick={() => navigate(r.kind === 'flow' ? `/flows/${r.id}` : r.kind === 'mock' ? `/mocks/${r.id}` : `/protocols/${r.id}`)}>
              <span style={{ fontSize: 12.5 }}>{r.kind === 'flow' ? '▤' : r.kind === 'mock' ? '◈' : '⫶'} {r.name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

const listPane: CSSProperties = { display: 'grid', gridTemplateRows: 'auto auto auto auto 1fr', gap: 8, padding: '18px 14px', borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', minHeight: 0 }
const search: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const chip: CSSProperties = { padding: '3px 9px', border: '1px solid var(--fl-border)', borderRadius: 999, background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 11.5, cursor: 'pointer' }
const chipOn: CSSProperties = { background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontWeight: 700 }
const newBtn: CSSProperties = { padding: '7px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left' }
const item: CSSProperties = { display: 'grid', gap: 2, textAlign: 'left', padding: '8px 10px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', minWidth: 0, width: '100%' }
const itemOn: CSSProperties = { background: 'var(--fl-surface-2)', borderColor: 'var(--fl-border)' }
const muted: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', padding: '6px 2px' }
const empty: CSSProperties = { height: '100%', display: 'grid', alignContent: 'center', justifyItems: 'center', textAlign: 'center', color: 'var(--fl-text-muted)', padding: 40 }
const hdr: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)', flexWrap: 'wrap', flexShrink: 0 }
const nameInput: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 16, border: '1px solid transparent', background: 'transparent', color: 'var(--fl-text)', padding: '4px 6px', borderRadius: 6, minWidth: 180 }
const metaMono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const statusBar: CSSProperties = { display: 'flex', gap: 8, padding: '4px 12px', borderTop: '1px solid var(--fl-border)', fontSize: 11, color: 'var(--fl-text-muted)', background: 'var(--fl-surface)' }
const primaryBtn: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const okBtn: CSSProperties = { ...primaryBtn, background: 'var(--fl-ok)' }
const dangerBtn: CSSProperties = { padding: '7px 12px', border: '1px solid color-mix(in srgb, var(--fl-fail) 45%, transparent)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const ghostBtn: CSSProperties = { padding: '7px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const pop: CSSProperties = { position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60, minWidth: 240, padding: 6, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow-lg)', display: 'grid', gap: 2 }
