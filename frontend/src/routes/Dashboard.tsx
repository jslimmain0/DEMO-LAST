import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ExecutionSummary, FlowSummary, FolderSummary } from '../api/types'
import { flowsApi, foldersApi, runsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { FlowGhost, FlowMini, FlowStrip, dominantCat, fallbackCats } from '../components/MiniFlow'
import { StatusBadge } from '../components/StatusBadge'
import { relTime } from '../lib/format'

type Sel = 'all' | 'none' | string // 'all' | 'none' | folderId
type Sort = 'recent' | 'name'

export function Dashboard() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const flows = useQuery({ queryKey: ['flows'], queryFn: flowsApi.list })
  const folders = useQuery({ queryKey: ['folders'], queryFn: foldersApi.list })
  const runs = useQuery({ queryKey: ['executions', 'recent'], queryFn: () => runsApi.recent(50) })

  const [sel, setSel] = useState<Sel>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<Sort>('recent')

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['flows'] })
    qc.invalidateQueries({ queryKey: ['folders'] })
  }

  const createFlow = useMutation({
    mutationFn: () => flowsApi.create({ name: '새 워크플로', folderId: isFolderId(sel) ? sel : null }),
    onSuccess: (flow) => navigate(`/flows/${flow.id}`),
  })
  const removeFlow = useMutation({ mutationFn: (id: string) => flowsApi.remove(id), onSuccess: invalidate })
  const duplicateFlow = useMutation({
    mutationFn: async (f: FlowSummary) => {
      const detail = await flowsApi.get(f.id)
      return flowsApi.importFlow({ name: `${f.name} 복제본`, nodes: detail.graph.nodes, edges: detail.graph.edges })
    },
    onSuccess: invalidate,
  })
  const moveFlow = useMutation({ mutationFn: (v: { id: string; folderId: string | null }) => flowsApi.move(v.id, v.folderId), onSuccess: invalidate })
  const createFolder = useMutation({ mutationFn: (name: string) => foldersApi.create(name), onSuccess: invalidate })
  const renameFolder = useMutation({ mutationFn: (v: { id: string; name: string }) => foldersApi.rename(v.id, v.name), onSuccess: invalidate })
  const removeFolder = useMutation({ mutationFn: (id: string) => foldersApi.remove(id), onSuccess: () => { setSel('all'); invalidate() } })

  const folderList: FolderSummary[] = folders.data ?? []
  const allFlows: FlowSummary[] = flows.data ?? []

  // recent() 한 번으로 모든 카드·hero 의 '최근 실행'을 확보(카드별 N+1 회피). flowId 별 최신 1건.
  const lastRunByFlow = useMemo(() => {
    const m = new Map<string, ExecutionSummary>()
    for (const e of runs.data ?? []) if (!m.has(e.flowId)) m.set(e.flowId, e) // recent() 는 최신순
    return m
  }, [runs.data])

  const visible = useMemo(() => {
    let list = allFlows
    if (sel === 'none') list = list.filter((f) => !f.folderId)
    else if (isFolderId(sel)) list = list.filter((f) => f.folderId === sel)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q))
    list = [...list].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')))
    return list
  }, [allFlows, sel, search, sort])

  const noneCount = allFlows.filter((f) => !f.folderId).length
  const scopeName = sel === 'all' ? '전체 워크플로' : sel === 'none' ? '미분류' : folderList.find((f) => f.id === sel)?.name ?? '워크플로'
  // hero 는 전체 스코프·검색 없음일 때만, 가장 최근 수정 워크플로 하나로 페이지를 연다.
  const heroFlow = sel === 'all' && !search.trim()
    ? [...allFlows].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
    : undefined

  const folderNav = (
    <>
      <div style={sidebarLabel}>워크플로</div>
      <SidebarItem label="전체 워크플로" count={allFlows.length} active={sel === 'all'} onClick={() => setSel('all')} glyph="▤" />
      <SidebarItem label="미분류" count={noneCount} active={sel === 'none'} onClick={() => setSel('none')} glyph="◇" />
      <div style={sidebarLabel}>폴더</div>
          {folderList.map((f) => (
            <SidebarItem
              key={f.id}
              label={f.name}
              count={f.flowCount}
              active={sel === f.id}
              onClick={() => setSel(f.id)}
              glyph="▸"
              accent={fallbackCats(f.id, 1)[0]}
              onRename={() => { const n = prompt('폴더 이름', f.name); if (n && n.trim()) renameFolder.mutate({ id: f.id, name: n.trim() }) }}
              onDelete={() => { if (confirm(`'${f.name}' 폴더를 삭제할까요? 안의 워크플로는 미분류로 옮겨집니다.`)) removeFolder.mutate(f.id) }}
            />
          ))}
      <button onClick={() => { const n = prompt('새 폴더 이름'); if (n && n.trim()) createFolder.mutate(n.trim()) }} style={newFolderBtn}>+ 새 폴더</button>
    </>
  )

  return (
    <AppShellTier1 sidebarExtra={folderNav}>
      <div style={{ minWidth: 0, padding: '28px 40px 80px', display: 'flex', flexDirection: 'column', gap: 'var(--fl-sp-7)' }}>
          {/* hero 밴드 — 최근 워크플로를 실제 노드 흐름으로 연다 */}
          {heroFlow && <Hero flow={heroFlow} lastRun={lastRunByFlow.get(heroFlow.id)} />}

          {/* 툴바 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
              <h2 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-xl)', fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{scopeName}</h2>
              <span style={{ fontSize: 'var(--fl-fs-xs)', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{visible.length}</span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <span aria-hidden style={{ position: 'absolute', left: 11, color: 'var(--fl-text-muted)', fontSize: 13, pointerEvents: 'none' }}>⌕</span>
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="검색" aria-label="워크플로 검색" style={searchBox} />
              </div>
              <div style={seg} role="group" aria-label="정렬">
                <button onClick={() => setSort('recent')} style={segBtn(sort === 'recent')}>최근</button>
                <button onClick={() => setSort('name')} style={segBtn(sort === 'name')}>이름</button>
              </div>
              <button onClick={() => createFlow.mutate()} disabled={createFlow.isPending} style={primaryBtn}>+ 새 워크플로</button>
            </div>
          </div>

          {/* 그리드 */}
          {flows.isLoading && <Grid>{[0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)}</Grid>}
          {flows.isError && (
            <div style={errorBox}>
              <div style={{ fontSize: 22 }}>⚠</div>
              <div>
                <div style={{ fontWeight: 600 }}>백엔드(18080)에 연결하지 못했어요.</div>
                <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', marginTop: 4 }}>백엔드를 먼저 실행하세요 — <code style={codeChip}>scripts\dev-all.ps1</code></div>
              </div>
              <button onClick={() => flows.refetch()} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {flows.data && visible.length === 0 && (
            <EmptyState mode={search ? 'search' : sel === 'all' ? 'onboarding' : 'folder'} onCreate={() => createFlow.mutate()} onClearSearch={() => setSearch('')} />
          )}

          {visible.length > 0 && (
            <Grid>
              {visible.map((f) => (
                <FlowCard
                  key={f.id}
                  flow={f}
                  lastRun={lastRunByFlow.get(f.id)}
                  folderList={folderList}
                  onDuplicate={() => duplicateFlow.mutate(f)}
                  onDelete={() => { if (confirm(`'${f.name}' 워크플로를 삭제할까요? 되돌릴 수 없습니다.`)) removeFlow.mutate(f.id) }}
                  onMove={(folderId) => moveFlow.mutate({ id: f.id, folderId })}
                />
              ))}
            </Grid>
          )}
        </div>
    </AppShellTier1>
  )
}

// ---------- hero ----------

function Hero({ flow, lastRun }: { flow: FlowSummary; lastRun?: ExecutionSummary }) {
  const detail = useQuery({ queryKey: ['flow', flow.id], queryFn: () => flowsApi.get(flow.id) })
  const nodes = detail.data?.graph.nodes ?? []
  const miniNodes = nodes.map((n) => ({ type: n.type, cat: n.cat }))
  return (
    <section style={heroBand} aria-label="최근 워크플로">
      <div style={{ fontSize: 'var(--fl-fs-xs)', fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', letterSpacing: '.04em', textTransform: 'uppercase' }}>최근 작업</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap', marginTop: 10 }}>
        <div style={{ minWidth: 0 }}>
          <Link to={`/flows/${flow.id}`} style={{ display: 'block', fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-3xl)', fontWeight: 500, letterSpacing: '-.02em', color: 'var(--fl-text)', textDecoration: 'none', lineHeight: 1.05 }}>{flow.name}</Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            {miniNodes.length > 0 ? <FlowStrip nodes={miniNodes} /> : <div style={{ height: 30 }} />}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          {lastRun ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <StatusBadge status={lastRun.status} />
              <span style={{ fontSize: 'var(--fl-fs-xs)', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{relTime(lastRun.startedAt)}</span>
            </div>
          ) : (
            <span style={{ fontSize: 'var(--fl-fs-xs)', color: 'var(--fl-text-muted)' }}>아직 실행 전</span>
          )}
          <Link to={`/flows/${flow.id}`} style={heroOpenBtn}>열기 →</Link>
        </div>
      </div>
    </section>
  )
}

// ---------- 카드 ----------

function FlowCard({ flow, lastRun, folderList, onDuplicate, onDelete, onMove }: {
  flow: FlowSummary
  lastRun?: ExecutionSummary
  folderList: FolderSummary[]
  onDuplicate: () => void
  onDelete: () => void
  onMove: (folderId: string | null) => void
}) {
  const detail = useQuery({ queryKey: ['flow', flow.id], queryFn: () => flowsApi.get(flow.id) })
  const nodes = detail.data?.graph.nodes
  const cats = nodes?.map((n) => n.cat ?? n.type)
  const spine = dominantCat(cats, flow.id)
  const nodeCount = nodes?.length
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [menu])

  return (
    <article className="fl-flow-card" style={{ ...card, borderLeft: `3px solid ${varCat(spine)}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <Link to={`/flows/${flow.id}`} style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15.5, color: 'var(--fl-text)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flow.name}</Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, minHeight: 12 }}>
            {cats ? <FlowMini cats={cats} /> : <FlowMini cats={fallbackCats(flow.id, 4)} />}
            {nodeCount != null && <span style={metaMono}>노드 {nodeCount}</span>}
          </div>
        </div>
        <div ref={menuRef} className="fl-card-actions" style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={() => setMenu((v) => !v)} aria-label={`${flow.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu} title="작업" style={iconBtn}>⋯</button>
          {menu && (
            <div role="menu" style={menuBox}>
              <button role="menuitem" onClick={() => { onDuplicate(); setMenu(false) }} style={menuItem}>⧉ 복제</button>
              <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--fl-text-muted)' }}>폴더로 이동</div>
              <select aria-label="폴더 이동" value={flow.folderId ?? ''} onChange={(e) => { onMove(e.target.value || null); setMenu(false) }} style={menuSelect}>
                <option value="">미분류</option>
                {folderList.map((fo) => <option key={fo.id} value={fo.id}>{fo.name}</option>)}
              </select>
              <button role="menuitem" onClick={() => { onDelete(); setMenu(false) }} style={{ ...menuItem, color: 'var(--fl-fail)' }}>🗑 삭제</button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {lastRun ? (
          <>
            <StatusBadge status={lastRun.status} />
            <span style={metaMono}>{relTime(lastRun.startedAt)}</span>
          </>
        ) : (
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>미실행 · ▶ 실행하면 여기에 표시</span>
        )}
        <span style={{ marginLeft: 'auto', ...metaMono }}>v{flow.currentVersion} · {relTime(flow.updatedAt) || '방금'}</span>
      </div>
    </article>
  )
}

function CardSkeleton() {
  return (
    <div style={{ ...card, borderLeft: '3px solid var(--fl-border)' }}>
      <div style={{ height: 15, width: '55%', background: 'var(--fl-surface-2)', borderRadius: 5 }} />
      <div style={{ height: 9, width: 90, background: 'var(--fl-surface-2)', borderRadius: 5, marginTop: 12 }} />
      <div style={{ height: 20, width: 120, background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius-pill)', marginTop: 18 }} />
    </div>
  )
}

// ---------- 빈 상태 ----------

function EmptyState({ mode, onCreate, onClearSearch }: { mode: 'onboarding' | 'folder' | 'search'; onCreate: () => void; onClearSearch: () => void }) {
  if (mode === 'search') {
    return (
      <div style={emptyBox}>
        <div style={{ color: 'var(--fl-text-muted)', fontSize: 14 }}>검색 결과가 없습니다.</div>
        <button onClick={onClearSearch} style={{ ...ghostBtn, marginTop: 14 }}>검색 지우기</button>
      </div>
    )
  }
  if (mode === 'folder') {
    return <div style={emptyBox}><div style={{ color: 'var(--fl-text-muted)', fontSize: 14 }}>이 폴더에 워크플로가 없습니다.</div></div>
  }
  return (
    <div style={{ ...emptyBox, padding: '56px 48px', display: 'grid', gap: 18, justifyItems: 'center' }}>
      <FlowGhost />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 18 }}>첫 워크플로를 만들어 보세요</div>
        <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6 }}>노드를 이어 API 호출·폼·콜백·검증 흐름을 그리고 실행합니다.</div>
      </div>
      <button onClick={onCreate} style={primaryBtn}>+ 새 워크플로</button>
    </div>
  )
}

// ---------- 사이드바 항목 ----------

function SidebarItem({ label, count, active, onClick, glyph, accent, onRename, onDelete }: { label: string; count: number; active: boolean; onClick: () => void; glyph: string; accent?: string; onRename?: () => void; onDelete?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', borderRadius: 'var(--fl-radius-sm)', background: active ? 'var(--fl-surface-2)' : 'transparent', borderLeft: `2px solid ${active ? 'var(--fl-primary)' : 'transparent'}` }}>
      <button onClick={onClick} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontWeight: active ? 600 : 500, fontSize: 13.5, textAlign: 'left' }}>
        <span aria-hidden style={{ width: 16, textAlign: 'center', color: accent ? varCat(accent) : 'inherit' }}>{glyph}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{count}</span>
      </button>
      {onRename && <button onClick={onRename} aria-label="이름 변경" title="이름 변경" style={miniBtn}>✎</button>}
      {onDelete && <button onClick={onDelete} aria-label="삭제" title="삭제" style={miniBtn}>×</button>}
    </div>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 400px))', justifyContent: 'start', gap: 20 }}>{children}</div>
}

function isFolderId(s: Sel): s is string {
  return s !== 'all' && s !== 'none'
}

// cat 키 → CSS 변수 참조. MiniFlow 의 catColor 와 동일 매핑.
function varCat(cat: string): string {
  const known = ['auth', 'bank', 'card', 'generic', 'set', 'if', 'assert', 'form', 'input', 'wait', 'start', 'end']
  if (known.includes(cat)) return `var(--fl-cat-${cat})`
  if (cat === 'transform') return 'var(--fl-patch)'
  return 'var(--fl-cat-generic)'
}

const sidebarLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '16px 8px 6px' }
const newFolderBtn: CSSProperties = { width: '100%', marginTop: 8, padding: '8px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
const heroBand: CSSProperties = { padding: '24px 28px', borderRadius: 'var(--fl-radius-lg)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)' }
const heroOpenBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--fl-primary)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 10, fontWeight: 600, fontSize: 13.5, textDecoration: 'none' }
const primaryBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fl-primary)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 10, fontWeight: 600, fontSize: 13.5, cursor: 'pointer', height: 38 }
const ghostBtn: CSSProperties = { border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '8px 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const searchBox: CSSProperties = { padding: '0 12px 0 30px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, width: 200 }
const seg: CSSProperties = { display: 'flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }
const segBtn = (on: boolean): CSSProperties => ({ padding: '0 12px', border: 'none', background: on ? 'var(--fl-surface-2)' : 'transparent', color: on ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontSize: 12.5, fontWeight: on ? 600 : 500, cursor: 'pointer' })
const card: CSSProperties = { background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', padding: '16px 18px', boxShadow: 'var(--fl-shadow)' }
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const iconBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', color: 'var(--fl-text-muted)', fontSize: 15 }
const miniBtn: CSSProperties = { width: 24, height: 28, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
const menuBox: CSSProperties = { position: 'absolute', top: 34, right: 0, width: 168, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 20, display: 'grid', gap: 2 }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const menuSelect: CSSProperties = { width: '100%', padding: '6px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: 40, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 14 }
const errorBox: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, border: '1px solid var(--fl-fail)', borderRadius: 12, padding: 18, color: 'var(--fl-text)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
