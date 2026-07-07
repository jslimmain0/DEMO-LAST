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
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)

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
      const created = await flowsApi.importFlow({ name: `${f.name} 복제본`, nodes: detail.graph.nodes, edges: detail.graph.edges })
      // 폴더 안에서 복제하면 같은 폴더에 복제본이 생긴다(탐색기 규칙)
      if (f.folderId) await flowsApi.move(created.id, f.folderId)
      return created
    },
    onSuccess: invalidate,
  })
  const moveFlow = useMutation({ mutationFn: (v: { id: string; folderId: string | null }) => flowsApi.move(v.id, v.folderId), onSuccess: invalidate })
  const moveFolder = useMutation({ mutationFn: (v: { id: string; parentId: string | null }) => foldersApi.move(v.id, v.parentId), onSuccess: invalidate })
  const createFolder = useMutation({ mutationFn: (v: { name: string; parentId: string | null }) => foldersApi.create(v.name, v.parentId), onSuccess: invalidate })
  const renameFolder = useMutation({ mutationFn: (v: { id: string; name: string }) => foldersApi.rename(v.id, v.name), onSuccess: invalidate })
  const removeFolder = useMutation({ mutationFn: (id: string) => foldersApi.remove(id), onSuccess: invalidate })

  // 렌더마다 새 [] 가 만들어져 useMemo 의존성이 매번 갈리는 것 방지
  const folderList: FolderSummary[] = useMemo(() => folders.data ?? [], [folders.data])
  const allFlows: FlowSummary[] = useMemo(() => flows.data ?? [], [flows.data])

  // ---- 폴더 트리(중첩) ----
  const childFolders = (parentId: string | null) => folderList.filter((f) => (f.parentId ?? null) === parentId)
  // 현재 스코프의 하위 폴더(탐색기 타일) — 전체=루트 폴더들, 폴더 안=그 폴더의 하위. 미분류/검색 중엔 없음.
  const scopeFolders = sel === 'none' || search.trim() ? [] : childFolders(isFolderId(sel) ? sel : null)
  // 브레드크럼 경로(루트→현재). 데이터 오염(사이클)에도 멈추도록 가드.
  const folderPath = useMemo(() => {
    if (!isFolderId(sel)) return [] as FolderSummary[]
    const byId = new Map(folderList.map((f) => [f.id, f]))
    const path: FolderSummary[] = []
    let cur = byId.get(sel)
    let guard = 0
    while (cur && guard++ < 30) {
      path.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return path
  }, [sel, folderList])
  // 이동 select 용 평탄화(트리 순서 + 깊이)
  const flatFolders = useMemo(() => {
    const out: Array<{ f: FolderSummary; depth: number }> = []
    const walk = (parentId: string | null, depth: number) => {
      if (depth > 30) return
      for (const f of folderList.filter((x) => (x.parentId ?? null) === parentId)) {
        out.push({ f, depth })
        walk(f.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }, [folderList])

  const newFolderIn = (parentId: string | null) => {
    const n = prompt(parentId ? '새 하위 폴더 이름' : '새 폴더 이름')
    if (n && n.trim()) createFolder.mutate({ name: n.trim(), parentId })
  }

  // ---- 드래그&드롭 (탐색기) ----
  // 같은 창 안 드래그라 dataTransfer 대신 ref 로 페이로드를 들고 다닌다(드래그오버 중에도 검증 가능).
  const dragRef = useRef<{ kind: 'flows'; ids: string[] } | { kind: 'folder'; id: string } | null>(null)
  const [dragging, setDragging] = useState(false) // 드롭 가능한 타깃 하이라이트용

  const isDescendantOf = (candidateId: string, ancestorId: string): boolean => {
    const byId = new Map(folderList.map((f) => [f.id, f]))
    let cur = byId.get(candidateId)
    let guard = 0
    while (cur && guard++ < 50) {
      if (cur.id === ancestorId) return true
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return false
  }
  /** 지금 끌고 있는 것을 folderId(null=루트/미분류)에 놓을 수 있는가 — 폴더는 자기/자기 하위 금지. */
  const canDropInto = (folderId: string | null): boolean => {
    const d = dragRef.current
    if (!d) return false
    if (d.kind === 'flows') return true
    if (folderId == null) return (folderList.find((f) => f.id === d.id)?.parentId ?? null) !== null
    return d.id !== folderId && !isDescendantOf(folderId, d.id)
  }
  const performDrop = (folderId: string | null) => {
    const d = dragRef.current
    if (!d || !canDropInto(folderId)) return
    if (d.kind === 'flows') {
      for (const fid of d.ids) moveFlow.mutate({ id: fid, folderId })
      if (selectMode) exitSelect()
    } else {
      moveFolder.mutate({ id: d.id, parentId: folderId })
    }
    dragRef.current = null
    setDragging(false)
  }
  const startFlowDrag = (flowId: string) => {
    // 탐색기 규칙: 선택된 카드를 끌면 선택 전체가 함께 이동
    const ids = selectMode && selectedIds.has(flowId) ? [...selectedIds] : [flowId]
    dragRef.current = { kind: 'flows', ids }
    setDragging(true)
  }
  const startFolderDrag = (folderId: string) => {
    dragRef.current = { kind: 'folder', id: folderId }
    setDragging(true)
  }
  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
  }
  // 일괄 폴더 이동(선택 모드 액션 바)
  const bulkMove = (folderId: string | null) => {
    for (const id of selectedIds) moveFlow.mutate({ id, folderId })
    exitSelect()
  }
  const deleteFolder = (f: FolderSummary) => {
    if (confirm(`'${f.name}' 폴더를 삭제할까요? 안의 워크플로와 하위 폴더는 상위로 옮겨집니다.`)) {
      if (sel === f.id) setSel(f.parentId ?? 'all')
      removeFolder.mutate(f.id)
    }
  }

  // recent() 한 번으로 모든 카드·hero 의 '최근 실행'을 확보(카드별 N+1 회피). flowId 별 최신 1건.
  const lastRunByFlow = useMemo(() => {
    const m = new Map<string, ExecutionSummary>()
    for (const e of runs.data ?? []) if (!m.has(e.flowId)) m.set(e.flowId, e) // recent() 는 최신순
    return m
  }, [runs.data])

  const visible = useMemo(() => {
    let list = allFlows
    const q = search.trim().toLowerCase()
    if (sel === 'none') list = list.filter((f) => !f.folderId)
    else if (isFolderId(sel)) list = list.filter((f) => f.folderId === sel)
    // 홈(루트)은 탐색기처럼 미분류만 — 폴더 안 워크플로는 폴더에 들어가야 보인다. 검색 중엔 전체를 뒤진다.
    else if (!q) list = list.filter((f) => !f.folderId)
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || (f.description ?? '').toLowerCase().includes(q))
    list = [...list].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')))
    return list
  }, [allFlows, sel, search, sort])

  // ---- 다중 선택 + 일괄 삭제 ----
  const visibleIds = visible.map((f) => f.id)
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id))
  const someSelected = visibleIds.some((id) => selectedIds.has(id))
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected
  }, [someSelected, allSelected])

  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()) }
  const toggleSelectMode = () => { if (selectMode) exitSelect(); else setSelectMode(true) }
  const toggleOne = (id: string) => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleAll = () => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (allSelected) visibleIds.forEach((id) => next.delete(id))
    else visibleIds.forEach((id) => next.add(id))
    return next
  })
  const bulkDelete = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!confirm(`선택한 ${ids.length}개 워크플로를 삭제할까요? 되돌릴 수 없습니다.`)) return
    try {
      await Promise.all(ids.map((id) => flowsApi.remove(id)))
    } catch (e) {
      console.warn('일괄 삭제 중 일부 실패', e)
    }
    invalidate()
    exitSelect()
  }

  const noneCount = allFlows.filter((f) => !f.folderId).length
  const scopeName = sel === 'all' ? (search.trim() ? '검색 (전체)' : '홈') : sel === 'none' ? '미분류' : folderList.find((f) => f.id === sel)?.name ?? '워크플로'
  // hero 는 전체 스코프·검색 없음일 때만, 가장 최근 수정 워크플로 하나로 페이지를 연다.
  const heroFlow = sel === 'all' && !search.trim()
    ? [...allFlows].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]
    : undefined

  // 사이드바 폴더 트리 — 들여쓰기로 중첩 표현. 각 항목은 드롭 타깃(워크플로/폴더 이동).
  const dropTo = (folderId: string | null) => ({
    canDrop: () => canDropInto(folderId),
    onDrop: () => performDrop(folderId),
    dragging,
  })
  const renderFolderTree = (parentId: string | null, depth: number): ReactNode =>
    childFolders(parentId).map((f) => (
      <div key={f.id}>
        <SidebarItem
          label={f.name}
          count={f.flowCount}
          active={sel === f.id}
          onClick={() => setSel(f.id)}
          glyph={depth === 0 ? '▸' : '·'}
          indent={depth}
          accent={fallbackCats(f.id, 1)[0]}
          drop={dropTo(f.id)}
          onRename={() => { const n = prompt('폴더 이름', f.name); if (n && n.trim()) renameFolder.mutate({ id: f.id, name: n.trim() }) }}
          onDelete={() => deleteFolder(f)}
        />
        {depth < 30 && renderFolderTree(f.id, depth + 1)}
      </div>
    ))

  const folderNav = (
    <>
      <div style={sidebarLabel}>워크플로</div>
      {/* 홈 = 탐색기 루트: 폴더 타일 + 미분류 워크플로. 여기로 드롭하면 폴더 밖(미분류)으로 꺼낸다. */}
      <SidebarItem label="홈" count={noneCount} active={sel === 'all'} onClick={() => setSel('all')} glyph="▤" drop={dropTo(null)} />
      <div style={sidebarLabel}>폴더</div>
      {renderFolderTree(null, 0)}
      <button onClick={() => newFolderIn(null)} style={newFolderBtn}>+ 새 폴더</button>
    </>
  )

  return (
    <AppShellTier1 sidebarExtra={folderNav}>
      <div style={{ minWidth: 0, padding: '28px 40px 80px', display: 'flex', flexDirection: 'column', gap: 'var(--fl-sp-7)' }}>
          {/* hero 밴드 — 최근 워크플로를 실제 노드 흐름으로 연다 */}
          {heroFlow && <Hero flow={heroFlow} lastRun={lastRunByFlow.get(heroFlow.id)} />}

          {/* 툴바 — 폴더 안이면 브레드크럼(전체 › 부모 › 현재)으로 위로 이동 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
              {folderPath.length > 0 ? (
                <nav aria-label="폴더 경로" style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
                  <CrumbButton label="홈" onClick={() => setSel('all')} drop={dropTo(null)} />
                  {folderPath.map((p, i) => (
                    <span key={p.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span aria-hidden style={{ color: 'var(--fl-text-muted)', fontSize: 13 }}>›</span>
                      {i === folderPath.length - 1 ? (
                        <h2 style={crumbCurrent}>{p.name}</h2>
                      ) : (
                        <CrumbButton label={p.name} onClick={() => setSel(p.id)} drop={dropTo(p.id)} />
                      )}
                    </span>
                  ))}
                </nav>
              ) : (
                <h2 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-xl)', fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{scopeName}</h2>
              )}
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
              {(visible.length > 0 || selectMode) && (
                <button onClick={toggleSelectMode} aria-pressed={selectMode} style={selectToggleBtn(selectMode)}>{selectMode ? '선택 완료' : '☑ 선택'}</button>
              )}
              <button onClick={() => createFlow.mutate()} disabled={createFlow.isPending} style={primaryBtn}>+ 새 워크플로</button>
            </div>
          </div>

          {/* 선택 액션 바 */}
          {selectMode && (
            <div style={selectBar}>
              <label style={selectAllLabel}>
                <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 16, height: 16, accentColor: 'var(--fl-primary)', cursor: 'pointer' }} />
                전체 선택
              </label>
              <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{selectedIds.size}개 선택됨</span>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>· 카드를 폴더로 끌어다 놓거나:</span>
              <select
                aria-label="선택 항목 폴더로 이동"
                value=""
                disabled={selectedIds.size === 0}
                onChange={(e) => { if (e.target.value) bulkMove(e.target.value === '@none' ? null : e.target.value) }}
                style={bulkMoveSel}
              >
                <option value="">폴더로 이동…</option>
                <option value="@none">미분류</option>
                {flatFolders.map(({ f: fo, depth }) => (
                  <option key={fo.id} value={fo.id}>{'  '.repeat(depth) + (depth > 0 ? '└ ' : '') + fo.name}</option>
                ))}
              </select>
              <button onClick={bulkDelete} disabled={selectedIds.size === 0} style={{ ...dangerBtn(selectedIds.size === 0), marginLeft: 'auto' }}>🗑 선택 삭제 ({selectedIds.size})</button>
            </div>
          )}

          {/* 폴더 타일(탐색기) — 현재 위치의 하위 폴더를 크게, 클릭해 들어간다. 드래그로 넣기/재배치 가능 */}
          {(scopeFolders.length > 0 || (sel !== 'none' && !search.trim() && !selectMode)) && (
            <div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 10 }}>폴더</div>
              <div style={folderGrid}>
                {scopeFolders.map((f) => (
                  <FolderTile
                    key={f.id}
                    folder={f}
                    subCount={childFolders(f.id).length}
                    onOpen={() => setSel(f.id)}
                    drop={dropTo(f.id)}
                    onDragStartSelf={() => startFolderDrag(f.id)}
                    onDragEndSelf={endDrag}
                    onRename={() => { const n = prompt('폴더 이름', f.name); if (n && n.trim()) renameFolder.mutate({ id: f.id, name: n.trim() }) }}
                    onDelete={() => deleteFolder(f)}
                  />
                ))}
                {sel !== 'none' && !search.trim() && !selectMode && (
                  <button
                    onClick={() => newFolderIn(isFolderId(sel) ? sel : null)}
                    aria-label={isFolderId(sel) ? '이 폴더 안에 새 폴더' : '새 폴더 만들기'}
                    style={newFolderTile}
                  >
                    <span aria-hidden style={{ fontSize: 22, lineHeight: 1 }}>+</span>
                    <span>새 폴더</span>
                  </button>
                )}
              </div>
            </div>
          )}

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
          {flows.data && visible.length === 0 && (search.trim() !== '' || scopeFolders.length === 0) && (
            <EmptyState mode={search ? 'search' : sel === 'all' ? 'onboarding' : 'folder'} onCreate={() => createFlow.mutate()} onClearSearch={() => setSearch('')} />
          )}

          {visible.length > 0 && (
            <div>
              {!selectMode && !search.trim() && sel !== 'none' && (
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 10 }}>워크플로</div>
              )}
            <Grid>
              {visible.map((f) => (
                <FlowCard
                  key={f.id}
                  flow={f}
                  lastRun={lastRunByFlow.get(f.id)}
                  folderOptions={flatFolders}
                  selectMode={selectMode}
                  selected={selectedIds.has(f.id)}
                  onToggleSelect={() => toggleOne(f.id)}
                  onDuplicate={() => duplicateFlow.mutate(f)}
                  onDelete={() => { if (confirm(`'${f.name}' 워크플로를 삭제할까요? 되돌릴 수 없습니다.`)) removeFlow.mutate(f.id) }}
                  onMove={(folderId) => moveFlow.mutate({ id: f.id, folderId })}
                  onDragStartSelf={() => startFlowDrag(f.id)}
                  onDragEndSelf={endDrag}
                />
              ))}
            </Grid>
            </div>
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

function FlowCard({ flow, lastRun, folderOptions, selectMode, selected, onToggleSelect, onDuplicate, onDelete, onMove, onDragStartSelf, onDragEndSelf }: {
  flow: FlowSummary
  lastRun?: ExecutionSummary
  folderOptions: Array<{ f: FolderSummary; depth: number }> // 트리 순서 + 깊이(들여쓰기 라벨)
  selectMode: boolean
  selected: boolean
  onToggleSelect: () => void
  onDuplicate: () => void
  onDelete: () => void
  onMove: (folderId: string | null) => void
  onDragStartSelf: () => void
  onDragEndSelf: () => void
}) {
  const navigate = useNavigate()
  const detail = useQuery({ queryKey: ['flow', flow.id], queryFn: () => flowsApi.get(flow.id) })
  const nodes = detail.data?.graph.nodes
  const cats = nodes?.map((n) => n.cat ?? n.type)
  const spine = dominantCat(cats, flow.id)
  const nodeCount = nodes?.length
  const [menu, setMenu] = useState(false)
  const openCard = selectMode ? onToggleSelect : () => navigate(`/flows/${flow.id}`)
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
    <article
      className="fl-flow-card"
      role="button"
      tabIndex={0}
      onClick={openCard}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard() } }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', flow.name) // 외부 드롭용 표시값(내부 이동은 ref 기반)
        onDragStartSelf()
      }}
      onDragEnd={onDragEndSelf}
      style={{ ...card, borderLeft: `3px solid ${varCat(spine)}`, cursor: 'pointer', ...(selected ? selectedCard : null) }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        {selectMode && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={`${flow.name} 선택`}
            style={cardCheckbox}
          />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <span style={cardTitle}>{flow.name}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, minHeight: 12 }}>
            {cats ? <FlowMini cats={cats} /> : <FlowMini cats={fallbackCats(flow.id, 4)} />}
            {nodeCount != null && <span style={metaMono}>노드 {nodeCount}</span>}
          </div>
        </div>
        {!selectMode && (
          <div ref={menuRef} className="fl-card-actions" onClick={(e) => e.stopPropagation()} style={{ position: 'relative', flexShrink: 0 }}>
            <button onClick={() => setMenu((v) => !v)} aria-label={`${flow.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu} title="작업" style={iconBtn}>⋯</button>
            {menu && (
              <div role="menu" style={menuBox}>
                <button role="menuitem" onClick={() => { onDuplicate(); setMenu(false) }} style={menuItem}>⧉ 복제</button>
                <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--fl-text-muted)' }}>폴더로 이동</div>
                <select aria-label="폴더 이동" value={flow.folderId ?? ''} onChange={(e) => { onMove(e.target.value || null); setMenu(false) }} style={menuSelect}>
                  <option value="">미분류</option>
                  {folderOptions.map(({ f: fo, depth }) => (
                    <option key={fo.id} value={fo.id}>{'  '.repeat(depth) + (depth > 0 ? '└ ' : '') + fo.name}</option>
                  ))}
                </select>
                <button role="menuitem" onClick={() => { onDelete(); setMenu(false) }} style={{ ...menuItem, color: 'var(--fl-fail)' }}>🗑 삭제</button>
              </div>
            )}
          </div>
        )}
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

/** 드롭 타깃 공통 명세 — canDrop 은 드래그오버 중 유효성(사이클 등) 판단, dragging 은 하이라이트 힌트. */
interface DropSpec {
  canDrop: () => boolean
  onDrop: () => void
  dragging: boolean
}

/** 탐색기식 폴더 타일 — 클릭해 들어가고, 드래그로 넣기/재배치, 호버 시 이름변경/삭제. */
function FolderTile({ folder, subCount, onOpen, drop, onDragStartSelf, onDragEndSelf, onRename, onDelete }: {
  folder: FolderSummary
  subCount: number
  onOpen: () => void
  drop: DropSpec
  onDragStartSelf: () => void
  onDragEndSelf: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const [over, setOver] = useState(false)
  const accent = varCat(fallbackCats(folder.id, 1)[0])
  return (
    <article
      className="fl-flow-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      aria-label={`${folder.name} 폴더 열기`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', folder.name)
        onDragStartSelf()
      }}
      onDragEnd={() => { setOver(false); onDragEndSelf() }}
      onDragOver={(e) => {
        if (!drop.canDrop()) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); drop.onDrop() }}
      style={{
        ...folderTileStyle,
        ...(over ? dropActive : null),
        ...(drop.dragging && drop.canDrop() && !over ? dropHint : null),
      }}
    >
      <FolderGlyph color={accent} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder.name}</div>
        <div style={{ ...metaMono, marginTop: 4 }}>
          워크플로 {folder.flowCount}{subCount > 0 ? ` · 폴더 ${subCount}` : ''}
        </div>
      </div>
      <div className="fl-card-actions" onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexShrink: 0 }}>
        <button onClick={onRename} aria-label="이름 변경" title="이름 변경" style={miniBtn}>✎</button>
        <button onClick={onDelete} aria-label="삭제" title="삭제" style={miniBtn}>×</button>
      </div>
    </article>
  )
}

function FolderGlyph({ color }: { color: string }) {
  return (
    <svg width="34" height="28" viewBox="0 0 34 28" aria-hidden style={{ flexShrink: 0 }}>
      <path d="M2 5.5C2 4.1 3.1 3 4.5 3h8l3 3.5h14c1.4 0 2.5 1.1 2.5 2.5v14c0 1.4-1.1 2.5-2.5 2.5h-25C3.1 25.5 2 24.4 2 23V5.5Z"
        fill={`color-mix(in srgb, ${color} 22%, var(--fl-surface-2))`} stroke={color} strokeWidth="1.6" />
    </svg>
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

function SidebarItem({ label, count, active, onClick, glyph, accent, indent = 0, drop, onRename, onDelete }: { label: string; count: number; active: boolean; onClick: () => void; glyph: string; accent?: string; indent?: number; drop?: DropSpec; onRename?: () => void; onDelete?: () => void }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={drop ? (e) => { if (!drop.canDrop()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true) } : undefined}
      onDragLeave={drop ? () => setOver(false) : undefined}
      onDrop={drop ? (e) => { e.preventDefault(); setOver(false); drop.onDrop() } : undefined}
      style={{
        display: 'flex', alignItems: 'center', borderRadius: 'var(--fl-radius-sm)',
        background: over ? 'color-mix(in srgb, var(--fl-primary) 14%, var(--fl-surface))' : active ? 'var(--fl-surface-2)' : 'transparent',
        borderLeft: `2px solid ${over ? 'var(--fl-primary)' : active ? 'var(--fl-primary)' : 'transparent'}`,
        outline: over ? '1.5px dashed var(--fl-primary)' : 'none', outlineOffset: -1,
      }}>
      <button onClick={onClick} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', paddingLeft: 10 + Math.min(indent, 8) * 14, border: 'none', background: 'transparent', cursor: 'pointer', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontWeight: active ? 600 : 500, fontSize: 13.5, textAlign: 'left' }}>
        <span aria-hidden style={{ width: 16, textAlign: 'center', color: accent ? varCat(accent) : 'inherit' }}>{glyph}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{count}</span>
      </button>
      {onRename && <button onClick={onRename} aria-label="이름 변경" title="이름 변경" style={miniBtn}>✎</button>}
      {onDelete && <button onClick={onDelete} aria-label="삭제" title="삭제" style={miniBtn}>×</button>}
    </div>
  )
}

/** 브레드크럼 버튼 — 클릭 이동 + 드롭 타깃(위 폴더/전체로 끌어올리기). */
function CrumbButton({ label, onClick, drop }: { label: string; onClick: () => void; drop: DropSpec }) {
  const [over, setOver] = useState(false)
  return (
    <button
      onClick={onClick}
      onDragOver={(e) => { if (!drop.canDrop()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); drop.onDrop() }}
      style={{
        ...crumbBtn,
        ...(over ? { color: 'var(--fl-primary)', outline: '1.5px dashed var(--fl-primary)', outlineOffset: 3, borderRadius: 6 } : null),
      }}
    >{label}</button>
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
  if (cat === 'tcp') return 'var(--fl-post)'
  return 'var(--fl-cat-generic)'
}

const sidebarLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '16px 8px 6px' }
const crumbBtn: CSSProperties = { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-xl)', fontWeight: 500, letterSpacing: '-.01em' }
const crumbCurrent: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-xl)', fontWeight: 600, letterSpacing: '-.01em', margin: 0 }
const folderGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 300px))', justifyContent: 'start', gap: 14 }
const folderTileStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', padding: '14px 16px', boxShadow: 'var(--fl-shadow)', cursor: 'pointer' }
// 드래그 중 드롭 가능한 폴더 힌트(연한 점선) / 드래그오버 중 활성(강조)
const dropHint: CSSProperties = { border: '1px dashed color-mix(in srgb, var(--fl-primary) 45%, var(--fl-border))' }
const dropActive: CSSProperties = { border: '1.5px dashed var(--fl-primary)', background: 'color-mix(in srgb, var(--fl-primary) 10%, var(--fl-surface))', boxShadow: 'var(--fl-shadow-lg)' }
const bulkMoveSel: CSSProperties = { height: 32, padding: '0 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const newFolderTile: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 58, border: '1.5px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
const newFolderBtn: CSSProperties = { width: '100%', marginTop: 8, padding: '8px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
const heroBand: CSSProperties = { padding: '24px 28px', borderRadius: 'var(--fl-radius-lg)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)' }
const heroOpenBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--fl-primary)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 10, fontWeight: 600, fontSize: 13.5, textDecoration: 'none' }
const primaryBtn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fl-primary)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 10, fontWeight: 600, fontSize: 13.5, cursor: 'pointer', height: 38 }
const ghostBtn: CSSProperties = { border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '8px 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const searchBox: CSSProperties = { padding: '0 12px 0 30px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, width: 200 }
const seg: CSSProperties = { display: 'flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }
const segBtn = (on: boolean): CSSProperties => ({ padding: '0 12px', border: 'none', background: on ? 'var(--fl-surface-2)' : 'transparent', color: on ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontSize: 12.5, fontWeight: on ? 600 : 500, cursor: 'pointer' })
const card: CSSProperties = { background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', padding: '16px 18px', boxShadow: 'var(--fl-shadow)' }
const cardTitle: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15.5, color: 'var(--fl-text)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const selectedCard: CSSProperties = { boxShadow: '0 0 0 2px var(--fl-primary), var(--fl-shadow)', background: 'var(--fl-surface-2)' }
const cardCheckbox: CSSProperties = { width: 18, height: 18, marginTop: 2, cursor: 'pointer', accentColor: 'var(--fl-primary)', flexShrink: 0 }
const selectToggleBtn = (on: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', border: `1px solid ${on ? 'var(--fl-primary)' : 'var(--fl-border)'}`, background: on ? 'var(--fl-surface-2)' : 'var(--fl-surface)', color: on ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontSize: 13, fontWeight: on ? 600 : 500, cursor: 'pointer' })
const selectBar: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', borderRadius: 'var(--fl-radius-sm)', border: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }
const selectAllLabel: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fl-text)', cursor: 'pointer', userSelect: 'none' }
const dangerBtn = (disabled: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--fl-fail)', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 10, fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, height: 36 })
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const iconBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', color: 'var(--fl-text-muted)', fontSize: 15 }
const miniBtn: CSSProperties = { width: 24, height: 28, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
const menuBox: CSSProperties = { position: 'absolute', top: 34, right: 0, width: 168, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 20, display: 'grid', gap: 2 }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const menuSelect: CSSProperties = { width: '100%', padding: '6px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: 40, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 14 }
const errorBox: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, border: '1px solid var(--fl-fail)', borderRadius: 12, padding: 18, color: 'var(--fl-text)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
