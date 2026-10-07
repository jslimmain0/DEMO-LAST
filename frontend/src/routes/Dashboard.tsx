import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { ExecutionSummary, FlowSummary, FolderSummary } from '../api/types'

import type { SuiteRunItem } from '../api/client'
import { WorkspaceDialog } from '../components/WorkspaceDialog'
import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { FlowGhost } from '../components/MiniFlow'
import { AppIcon, NodeTypeIcon } from '../components/AppIcon'
import { useAnchoredPopover } from '../components/useAnchoredPopover'
import { StatusBadge } from '../components/StatusBadge'
import { SuiteRunDialog } from '../components/SuiteRunDialog'
import { toast } from '../components/toast'
import { relTime } from '../lib/format'
import { apiErrorMessage } from '../lib/apiError'
import { catalogPage, matchesCatalog } from '../lib/catalog'
import { CatalogPagination } from '../components/CatalogPagination'
import { useCatalogNavigation } from '../lib/useCatalogNavigation'
import type { CatalogLink } from '../lib/catalogNavigation'
import './dashboard.css'
import { ui } from '../design/ui'

type Sel = 'all' | 'none' | string // 'all' | 'none' | folderId
type Sort = 'recent' | 'name'
type Layout = 'cards' | 'list'

function readLayout(key: string): Layout {
  try { return localStorage.getItem(key) === 'list' ? 'list' : 'cards' } catch { return 'cards' }
}

export function Dashboard() {
  const { adminApi, flowsApi, foldersApi, runsApi, suitesApi } = useApi()

  const qc = useQueryClient()
  const navigate = useNavigate()
  const catalog = useCatalogNavigation('flows')
  const { canEdit: canEditGlobal } = usePermissions()
  const { desktop } = useAuth()
  const scope = useWorkspace()
  const runtime = { kind: scope.current.origin }
  const wsId = scope.current.id

  // ---- 워크스페이스(폴더 위 최상위 스코프) ----
  const adminMe = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000 }) // 승인 대기 안내용(캐시 공유)
  const currentWs = scope.current
  const wsRole = currentWs?.myRole ?? 'EDITOR'
  const canEdit = canEditGlobal && wsRole !== 'VIEWER' // VIEWER 롤은 조회만
  const [wsDialog, setWsDialog] = useState(false)
  // 팀 생성 가능 여부 — 개인 워크스페이스 부재 = 게스트/승인 대기(백엔드 403 대신 옵션 자체를 숨김)
  const canCreateWs = scope.connected && (desktop || runtime.kind === 'server') && adminMe.data?.myStatus === 'APPROVED'

  const flows = useQuery({ queryKey: ['flows', wsId], queryFn: () => flowsApi.list(wsId) })
  const folders = useQuery({ queryKey: ['folders', wsId], queryFn: () => foldersApi.list(wsId) })
  // 최근 실행도 현재 워크스페이스 스코프 — 무스코프 조회가 타 ws 실행을 유출/배지 창을 잠식하던 갭
  const runs = useQuery({ queryKey: ['executions', 'recent', wsId], queryFn: () => runsApi.recent(50, wsId) })

  // 현재 위치(홈/폴더)는 URL(?folder=id)이 진실원 — 에디터에서 ←/브라우저 뒤로가기로 돌아와도
  // 보고 있던 폴더가 유지된다. 폴더 이동은 history 를 쌓아 탐색기처럼 뒤로가기로 상위 복귀 가능.
  const [params] = useSearchParams()
  const sel: Sel = params.get('folder') ?? 'all'
  const setSel = (s: Sel) => {
    const next = new URLSearchParams(params)
    if (s === 'all') next.delete('folder'); else next.set('folder', s)
    catalog.update({ page: 1 }, next.toString(), false)
  }
  // 워크스페이스 전환 — 위치/검색/선택 초기화 + localStorage 지속
  const setWsId = (id: string) => {
    scope.select(id)
    setSelectMode(false)
    setSelectedIds(new Set())
  }
  const search = catalog.view.search
  const sort = catalog.view.sort as Sort
  const setSearch = (search: string) => catalog.update({ search, page: 1 })
  const setSort = (sort: Sort) => catalog.update({ sort, page: 1 })
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectAllRef = useRef<HTMLInputElement>(null)
  // 보기는 사용자 선호이며 검색/페이지/선택 집합과 독립적이다.
  const layoutKey = `fl:flows:layout:${scope.scopeKey}`
  const [layoutPreference, setLayoutPreference] = useState(() => ({ key: layoutKey, value: readLayout(layoutKey) }))
  const layout = layoutPreference.key === layoutKey ? layoutPreference.value : readLayout(layoutKey)
  const setLayout = (value: Layout) => {
    setLayoutPreference({ key: layoutKey, value })
    try { localStorage.setItem(layoutKey, value) } catch { /* 프라이빗 모드 */ }
  }
  const [expandedFolderScope, setExpandedFolderScope] = useState<string | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['flows'] })
    qc.invalidateQueries({ queryKey: ['folders'] })
  }

  // URL 의 folder 가 삭제된/없는 폴더면 홈으로 정리(브레드크럼·필터가 빈 화면이 되는 것 방지)
  useEffect(() => {
    if (folders.data && isFolderId(sel) && !folders.data.some((f) => f.id === sel)) {
      const next = new URLSearchParams(params)
      next.delete('folder')
      catalog.update({ page: 1 }, next.toString())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders.data, sel])

  const createFlow = useMutation({
    mutationFn: () => flowsApi.create({ name: '새 워크플로', folderId: isFolderId(sel) ? sel : null, workspaceId: wsId === 'public' ? null : wsId }),
    onSuccess: invalidate,
  })
  // 호출별 콜백은 화면이 살아 있을 때만 실행된다. 공간 전환 후 늦은 응답이 현재 화면을 옮기지 않게 한다.
  const newFlow = () => createFlow.mutate(undefined, { onSuccess: flow => { const link = catalog.detail(flow.id); navigate(link.to, { state: link.state }) } })
  const removeFlow = useMutation({ mutationFn: (id: string) => flowsApi.remove(id), onSuccess: invalidate })
  const duplicateFlow = useMutation({
    mutationFn: async (f: FlowSummary) => {
      const detail = await flowsApi.get(f.id)
      const created = await flowsApi.importFlow({ name: `${f.name} 복제본`, nodes: detail.graph.nodes, edges: detail.graph.edges, workspaceId: wsId === 'public' ? undefined : wsId })
      // 폴더 안에서 복제하면 같은 폴더에 복제본이 생긴다(탐색기 규칙)
      if (f.folderId) await flowsApi.move(created.id, f.folderId)
      return created
    },
    onSuccess: invalidate,
  })
  const moveFlow = useMutation({ mutationFn: (v: { id: string; folderId: string | null }) => flowsApi.move(v.id, v.folderId), onSuccess: invalidate, onError: error => toast(apiErrorMessage(error, '워크플로를 이동하지 못했습니다. 접근 권한과 연결 상태를 확인하세요.'), 'error') })
  const moveFolder = useMutation({ mutationFn: (v: { id: string; parentId: string | null }) => foldersApi.move(v.id, v.parentId), onSuccess: invalidate, onError: error => toast(apiErrorMessage(error, '폴더를 이동하지 못했습니다. 접근 권한과 연결 상태를 확인하세요.'), 'error') })
  const createFolder = useMutation({ mutationFn: (v: { name: string; parentId: string | null }) => foldersApi.create(v.name, v.parentId, wsId), onSuccess: invalidate })
  const renameFolder = useMutation({ mutationFn: (v: { id: string; name: string }) => foldersApi.rename(v.id, v.name), onSuccess: invalidate })
  const removeFolder = useMutation({ mutationFn: (id: string) => foldersApi.remove(id), onSuccess: invalidate })
  const renameFlow = useMutation({ mutationFn: (v: { id: string; name: string }) => flowsApi.updateMeta(v.id, { name: v.name }), onSuccess: invalidate })
  const [suiteItems, setSuiteItems] = useState<SuiteRunItem[] | null>(null)
  const runSuite = useMutation({
    mutationFn: (body: { flowIds?: string[]; folderId?: string }) => suitesApi.run(body),
    onSuccess: (items) => { setSuiteItems(items); if (items.length === 0) toast('실행할 워크플로가 없습니다.', 'error') },
    onError: () => toast('스위트 실행에 실패했습니다.', 'error'),
  })

  // 앱 다이얼로그(prompt/confirm 대체)
  const [ask, setAsk] = useState<AskSpec | null>(null)

  // 즐겨찾기도 서버 주소·계정·워크스페이스별로 분리한다.
  const favKey = `fl:favorites:${scope.scopeKey}`
  const [favorites, setFavorites] = useState<string[]>([])
  useEffect(() => {
    try {
      const raw = localStorage.getItem(favKey)
      setFavorites(raw ? (JSON.parse(raw) as string[]) : [])
    } catch { setFavorites([]) }
  }, [favKey])
  const toggleFav = (id: string) => setFavorites((prev) => {
    const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev]
    try { localStorage.setItem(favKey, JSON.stringify(next)) } catch { /* 프라이빗 모드 */ }
    return next
  })

  // 렌더마다 새 [] 가 만들어져 useMemo 의존성이 매번 갈리는 것 방지
  const folderList: FolderSummary[] = useMemo(() => folders.data ?? [], [folders.data])
  const allFlows: FlowSummary[] = useMemo(() => flows.data ?? [], [flows.data])

  // ---- 폴더 트리(중첩) ----
  const childFolders = (parentId: string | null) => folderList.filter((f) => (f.parentId ?? null) === parentId)
  // 현재 스코프의 하위 폴더(탐색기 타일) — 전체=루트 폴더들, 폴더 안=그 폴더의 하위. 미분류/검색 중엔 없음.
  const scopeFolders = sel === 'none' || search.trim() ? [] : childFolders(isFolderId(sel) ? sel : null)
  const folderScopeKey = `${scope.scopeKey}:${sel}`
  const showAllFolders = expandedFolderScope === folderScopeKey
  const shownFolders = showAllFolders ? scopeFolders : scopeFolders.slice(0, 8)
  // URL 의 folder 가 이 워크스페이스에 실재할 때만 폴더 컨텍스트 액션 허용 — ws 전환 직후/뒤로가기로
  // 타 ws 폴더가 sel 에 남아 그 안에 생성·실행하는 교차 배치 방지(백엔드 400 방어와 이중)
  const scopeReady = !scope.loading && (!isFolderId(sel) || (folders.data?.some((f) => f.id === sel) ?? false))
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
  const folderLabels = useMemo(() => {
    const byId = new Map(folderList.map(folder => [folder.id, folder]))
    return new Map(folderList.map(folder => {
      const names: string[] = []
      const seen = new Set<string>()
      let current: FolderSummary | undefined = folder
      while (current && !seen.has(current.id)) {
        seen.add(current.id)
        names.unshift(current.name)
        current = current.parentId ? byId.get(current.parentId) : undefined
      }
      return [folder.id, names.join(' / ')]
    }))
  }, [folderList])
  const flowFolderLabel = (flow: FlowSummary) => flow.folderId ? folderLabels.get(flow.folderId) ?? '폴더 정보 없음' : '홈 · 미분류'

  const createWs = useMutation({
    mutationFn: (name: string) => scope.agentApi('server').workspacesApi.create(name),
    onSuccess: (ws) => { scope.refresh(); toast(`워크스페이스 "${ws.name}" 생성됨`, 'ok') },
    onError: (e) => toast((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '워크스페이스 생성에 실패했습니다.', 'error'),
  })
  const newTeamWs = () => setAsk({ title: '새 팀 워크스페이스', input: { label: '워크스페이스 이름', placeholder: '예: 결제팀' }, confirmLabel: '만들기', onConfirm: (name) => createWs.mutate(name, { onSuccess: ws => scope.select(ws.id, 'server') }) })

  const newFolderIn = (parentId: string | null) => {
    setAsk({ title: parentId ? '새 하위 폴더' : '새 폴더', input: { label: '폴더 이름', placeholder: '폴더 이름' }, confirmLabel: '만들기', onConfirm: (name) => createFolder.mutate({ name, parentId }) })
  }
  const askRenameFolder = (f: FolderSummary) => setAsk({ title: '폴더 이름 변경', input: { label: '폴더 이름', initial: f.name }, onConfirm: (name) => renameFolder.mutate({ id: f.id, name }) })
  const askRenameFlow = (f: FlowSummary) => setAsk({ title: '워크플로 이름 변경', input: { label: '이름', initial: f.name }, onConfirm: (name) => renameFlow.mutate({ id: f.id, name }) })

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
    if (!canEdit) return false
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
    setAsk({
      title: '폴더 삭제', danger: true, confirmLabel: '삭제',
      message: `'${f.name}' 폴더를 삭제할까요? 안의 워크플로와 하위 폴더는 상위로 옮겨집니다.`,
      onConfirm: () => { if (sel === f.id) setSel(f.parentId ?? 'all'); removeFolder.mutate(f.id) },
    })
  }

  // recent() 한 번으로 모든 카드의 '최근 실행'을 확보(카드별 N+1 회피). flowId 별 최신 1건.
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
    // 이름·설명 + 노드 내용(nodeText: 노드 이름/URL/조건 등)까지 가로질러 검색
    if (q) list = list.filter((f) => matchesCatalog(q, [f.name, f.description, f.nodeText]))
    list = [...list].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')))
    return list
  }, [allFlows, sel, search, sort])
  const flowPage = catalog.view.page
  const flowPageSize = catalog.view.size
  const setFlowPage = (page: number) => catalog.update({ page })
  const setFlowPageSize = (size: number) => catalog.update({ size, page: 1 })
  const page = catalogPage(visible.length, flowPage, flowPageSize)

  // ---- 다중 선택 + 일괄 삭제 ----
  const visibleIds = visible.map((f) => f.id)
  const selectedOutsideScope = [...selectedIds].filter(id => !visibleIds.includes(id)).length
  const pageIds = new Set(visible.slice(page.start, page.end).map(flow => flow.id))
  const selectedOutsidePage = [...selectedIds].filter(id => !pageIds.has(id)).length
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
  const bulkDelete = () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setAsk({
      title: '선택 삭제', danger: true, confirmLabel: '삭제',
      message: `선택한 ${ids.length}개 워크플로를 삭제할까요? 되돌릴 수 없습니다.`,
      onConfirm: async () => {
        try { await Promise.all(ids.map((id) => flowsApi.remove(id))) } catch (e) { console.warn('일괄 삭제 중 일부 실패', e) }
        invalidate()
        exitSelect()
      },
    })
  }

  const noneCount = allFlows.filter((f) => !f.folderId).length
  const scopeName = sel === 'all' ? (search.trim() ? '검색 (전체)' : '홈') : sel === 'none' ? '미분류' : folderList.find((f) => f.id === sel)?.name ?? '워크플로'

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
          glyph={<AppIcon name="folder" size={15} />}
          indent={depth}
          title={folderLabels.get(f.id)}
          drop={dropTo(f.id)}
        />
        {depth < 30 && renderFolderTree(f.id, depth + 1)}
      </div>
    ))

  const folderNav = (
    <>
      {wsRole === 'VIEWER' && <div style={{ padding: '0 12px 6px', fontSize: 12, color: 'var(--fl-text-muted)' }}>읽기전용 — 조회만 가능합니다</div>}
      {adminMe.data?.myStatus === 'PENDING' && (
        <div style={{ margin: '0 10px 6px', padding: '7px 10px', borderRadius: 'var(--fl-radius-sm)', background: 'color-mix(in srgb, var(--fl-waiting) 14%, transparent)', fontSize: 12, color: 'var(--fl-text)', lineHeight: 1.5 }}>
          가입 승인 대기 중 — 승인되면 팀·AI 를 쓸 수 있어요
        </div>
      )}
      {/* 홈 = 탐색기 루트: 폴더 타일 + 미분류 워크플로. 여기로 드롭하면 폴더 밖(미분류)으로 꺼낸다. */}
      <SidebarItem label="홈" count={noneCount} active={sel === 'all'} onClick={() => setSel('all')} glyph={<AppIcon name="flow" size={15} />} drop={dropTo(null)} />
      <div style={sidebarLabel}>폴더</div>
      {renderFolderTree(null, 0)}
      {canEdit && <button onClick={() => newFolderIn(null)} style={newFolderBtn}>+ 새 폴더</button>}
    </>
  )

  return (
    <AppShellTier1 sidebarExtra={folderNav}>
      <div className="fl-flow-workspace">
          <header className="fl-workbench-title">
            <div><h1>워크플로</h1></div>
            <div className="fl-library-header-actions">
              <div className="fl-flow-search" style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <AppIcon name="search" size={16} style={{ position: 'absolute', left: 11, color: 'var(--fl-text-muted)', pointerEvents: 'none' }} />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="워크플로 검색…" title="이름·설명·노드 내용으로 검색" aria-label={isFolderId(sel) ? '이 폴더의 워크플로 검색' : sel === 'none' ? '미분류 워크플로 검색' : '전체 워크플로 검색'} style={searchBox} onKeyDown={e => { if (e.key === 'Escape' && search) { e.stopPropagation(); setSearch('') } }} />
                {search && <button onClick={() => setSearch('')} aria-label="검색 지우기" title="지우기 (Esc)" style={{ position: 'absolute', right: 6, border: 0, background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer' }}><AppIcon name="close" size={14} /></button>}
              </div>
              {canEdit && <button onClick={newFlow} disabled={createFlow.isPending || !scopeReady} style={primaryBtn}><AppIcon name="plus" size={17} /> 새 워크플로</button>}
            </div>
          </header>

          {/* 툴바 — 폴더 안이면 브레드크럼(전체 › 부모 › 현재)으로 위로 이동 */}
          <div className="fl-flow-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
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
                <h2 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 14, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }}>{scopeName}</h2>
              )}
              <span style={{ fontSize: 'var(--fl-fs-xs)', color: 'var(--fl-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{visible.length}</span>
            </div>
            <div className="fl-flow-toolbar-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={seg} role="group" aria-label="정렬">
                <button onClick={() => setSort('recent')} aria-pressed={sort === 'recent'} style={segBtn(sort === 'recent')}>최근</button>
                <button onClick={() => setSort('name')} aria-pressed={sort === 'name'} style={segBtn(sort === 'name')}>이름</button>
              </div>
              <div className="fl-flow-view-toggle" style={seg} role="group" aria-label="워크플로 보기">
                <button onClick={() => setLayout('cards')} aria-pressed={layout === 'cards'} style={segBtn(layout === 'cards')}><AppIcon name="workspace" size={15} /> 카드</button>
                <button onClick={() => setLayout('list')} aria-pressed={layout === 'list'} style={segBtn(layout === 'list')}><AppIcon name="list" size={15} /> 목록</button>
              </div>
              {canEdit && sel !== 'all' && sel !== 'none' && !selectMode && (
                <button onClick={() => runSuite.mutate({ folderId: sel })} disabled={runSuite.isPending || !scopeReady} title="이 폴더의 워크플로를 한 번에 실행하고 성공/실패를 봅니다" style={selectToggleBtn(false)}>▶ 폴더 실행</button>
              )}
              {canEdit && (visible.length > 0 || selectMode) && (
                <button onClick={toggleSelectMode} aria-pressed={selectMode} style={selectToggleBtn(selectMode)}>{selectMode ? '선택 완료' : '☑ 선택'}</button>
              )}
              {canCreateWs && <button onClick={newTeamWs} className="fl-workbench-button"><AppIcon name="plus" size={14} /> 팀 공간</button>}
              <button onClick={() => setWsDialog(true)} aria-label="현재 공간 관리" title="현재 공간 관리" className="fl-workbench-button"><AppIcon name="settings" size={16} /></button>
            </div>
          </div>

          {/* 선택 액션 바 */}
          {selectMode && (
            <div className="fl-flow-selection" style={selectBar}>
              <label style={selectAllLabel}>
                <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 16, height: 16, accentColor: 'var(--fl-primary)', cursor: 'pointer' }} />
                현재 범위 전체 선택 ({visible.length})
              </label>
              <span style={{ fontSize: 13, color: 'var(--fl-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{selectedIds.size}개 선택됨</span>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>카드 본문 또는 체크박스로 선택</span>
              {selectedOutsidePage > 0 && <span className="fl-selection-hidden" role="status" style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>이 페이지 밖 {selectedOutsidePage}개{selectedOutsideScope > 0 ? ` · 현재 범위 밖 ${selectedOutsideScope}개 포함` : ''}</span>}
              {selectedIds.size > 0 && <button onClick={() => setSelectedIds(new Set())} style={ghostBtn}>선택 해제</button>}
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
              <button onClick={() => runSuite.mutate({ flowIds: [...selectedIds] })} disabled={selectedIds.size === 0 || runSuite.isPending} style={{ ...selectToggleBtn(false), marginLeft: 'auto' }}>▶ 선택 실행 ({selectedIds.size})</button>
              <button onClick={bulkDelete} disabled={selectedIds.size === 0} style={dangerBtn(selectedIds.size === 0)}>선택 삭제 ({selectedIds.size})</button>
            </div>
          )}

          {/* 하위 폴더가 없으면 섹션을 숨긴다 — 폴더 만들기는 사이드바의 '+ 새 폴더'. */}
          {sel !== 'none' && !search.trim() && (folders.isLoading || folders.isError || scopeFolders.length > 0) && (
            <section className="fl-folder-section" aria-label="하위 폴더">
              <div className="fl-folder-heading">
                <h3>폴더 <span>{scopeFolders.length}</span></h3>
                {canEdit && <button onClick={() => newFolderIn(isFolderId(sel) ? sel : null)} disabled={!scopeReady} style={ghostBtn}><AppIcon name="plus" size={14} /> 새 폴더</button>}
              </div>
              {folders.isLoading ? <p className="fl-folder-hint">폴더를 불러오는 중…</p>
                : folders.isError ? <p className="fl-folder-hint">폴더를 불러오지 못했습니다. <button onClick={() => folders.refetch()} style={ghostBtn}>다시 시도</button></p>
                : scopeFolders.length === 0 ? <p className="fl-folder-hint">{canEdit ? '폴더를 만들어 워크플로를 묶고, 카드를 끌어 정리하세요.' : '현재 위치에 하위 폴더가 없습니다.'}</p> : null}
              <div className="fl-folder-strip">
                {shownFolders.map((f) => (
                  <FolderTile
                    key={f.id}
                    folder={f}
                    subCount={childFolders(f.id).length}
                    onOpen={() => setSel(f.id)}
                    drop={dropTo(f.id)}
                    onDragStartSelf={() => startFolderDrag(f.id)}
                    onDragEndSelf={endDrag}
                    onRename={() => askRenameFolder(f)}
                    onDelete={() => deleteFolder(f)}
                    readOnly={!canEdit}
                  />
                ))}
              </div>
              {scopeFolders.length > 8 && <button className="fl-folder-more" aria-expanded={showAllFolders} onClick={() => setExpandedFolderScope(showAllFolders ? null : folderScopeKey)}>{showAllFolders ? '폴더 접기' : `폴더 ${scopeFolders.length - shownFolders.length}개 더 보기`}</button>}
            </section>
          )}

          {/* 그리드 */}
          {flows.isLoading && <Grid layout={layout}>{[0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)}</Grid>}
          {flows.isError && (
            <div style={errorBox}>
              <div style={{ fontSize: 24 }}>⚠</div>
              <div>
                <div style={{ fontWeight: 600 }}>이 공간의 워크플로를 불러오지 못했습니다.</div>
                <div style={{ fontSize: 13, color: 'var(--fl-text-muted)', marginTop: 4 }}>{scope.current.origin === 'local' ? '트레이에서 FlowLink가 실행 중인지 확인한 뒤 다시 시도하세요.' : '회사 서버 연결과 이 공간의 접근 권한을 확인한 뒤 다시 시도하세요.'}</div>
              </div>
              <button onClick={() => flows.refetch()} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {flows.data && visible.length === 0 && (search.trim() !== '' || scopeFolders.length === 0) && (
            <EmptyState mode={search ? 'search' : sel === 'all' ? 'onboarding' : 'folder'} canEdit={canEdit} ready={scopeReady} creating={createFlow.isPending} mockHref={`/mocks?space=${encodeURIComponent(`${scope.current.origin}:${scope.current.id}`)}`} onCreate={newFlow} onClearSearch={() => setSearch('')} />
          )}

          {/* 즐겨찾기 — 홈에서만, 검색·선택 모드 아닐 때 상단 고정 */}
          {sel === 'all' && !search.trim() && !selectMode && favorites.length > 0 && (() => {
            const favFlows = favorites.map((id) => allFlows.find((f) => f.id === id)).filter(Boolean) as FlowSummary[]
            if (favFlows.length === 0) return null
            return (
              <div style={{ marginBottom: 22 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fl-text-muted)', letterSpacing: '.05em', textTransform: 'uppercase', marginBottom: 10 }}>★ 즐겨찾기</div>
                <Grid layout={layout}>
                  {favFlows.map((f) => (
                    <FlowCard key={'fav-' + f.id} flow={f} detailLink={catalog.detail(f.id)} lastRun={lastRunByFlow.get(f.id)} runState={runs.isError ? 'error' : runs.isPending ? 'loading' : 'ready'} folderOptions={flatFolders} folderLabel={flowFolderLabel(f)}
                      selectMode={false} selected={false} onToggleSelect={() => {}}
                      pinned onTogglePin={() => toggleFav(f.id)}
                      onRename={() => askRenameFlow(f)} onDuplicate={() => duplicateFlow.mutate(f)}
                      onDelete={() => setAsk({ title: '워크플로 삭제', danger: true, confirmLabel: '삭제', message: `'${f.name}' 워크플로를 삭제할까요? 되돌릴 수 없습니다.`, onConfirm: () => removeFlow.mutate(f.id) })}
                      onMove={(folderId) => moveFlow.mutate({ id: f.id, folderId })} onDragStartSelf={() => startFlowDrag(f.id)} onDragEndSelf={endDrag} readOnly={!canEdit} />
                  ))}
                </Grid>
              </div>
            )
          })()}

          {visible.length > 0 && (
            <div>
              {layout === 'list' && !selectMode && !search.trim() && sel !== 'none' && (
                <div className="fl-flow-list-heading"><span>워크플로 이름</span><span>최근 실행 · 저장 버전</span></div>
              )}
            <Grid layout={layout}>
              {visible.slice(page.start, page.end).map((f) => (
                <FlowCard
                  key={f.id}
                  flow={f}
                  detailLink={catalog.detail(f.id)}
                  lastRun={lastRunByFlow.get(f.id)}
                  runState={runs.isError ? 'error' : runs.isPending ? 'loading' : 'ready'}
                  folderLabel={search.trim() ? flowFolderLabel(f) : undefined}
                  folderOptions={flatFolders}
                  selectMode={selectMode}
                  selected={selectedIds.has(f.id)}
                  onToggleSelect={() => toggleOne(f.id)}
                  pinned={favorites.includes(f.id)}
                  onTogglePin={() => toggleFav(f.id)}
                  onRename={() => askRenameFlow(f)}
                  onDuplicate={() => duplicateFlow.mutate(f)}
                  onDelete={() => setAsk({ title: '워크플로 삭제', danger: true, confirmLabel: '삭제', message: `'${f.name}' 워크플로를 삭제할까요? 되돌릴 수 없습니다.`, onConfirm: () => removeFlow.mutate(f.id) })}
                  onMove={(folderId) => moveFlow.mutate({ id: f.id, folderId })}
                  onDragStartSelf={() => startFlowDrag(f.id)}
                  onDragEndSelf={endDrag}
                  readOnly={!canEdit}
                />
              ))}
            </Grid>
            <CatalogPagination label="워크플로" total={visible.length} page={page.page} size={flowPageSize} onPage={setFlowPage} onSize={setFlowPageSize} />
            </div>
          )}
        </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      {suiteItems && <SuiteRunDialog items={suiteItems} onClose={() => setSuiteItems(null)} />}
      {wsDialog && currentWs && (
        <WorkspaceDialog
          current={currentWs}
          onClose={() => setWsDialog(false)}
          onDeleted={() => { setWsDialog(false); scope.refresh(); setWsId('public') }}
        />
      )}
    </AppShellTier1>
  )
}

// ---------- 카드 ----------

function FlowCard({ flow, detailLink, lastRun, runState, folderOptions, folderLabel, selectMode, selected, pinned, onTogglePin, onToggleSelect, onRename, onDuplicate, onDelete, onMove, onDragStartSelf, onDragEndSelf, readOnly }: {
  flow: FlowSummary
  detailLink: CatalogLink
  lastRun?: ExecutionSummary
  runState: 'loading' | 'error' | 'ready'
  folderOptions: Array<{ f: FolderSummary; depth: number }>
  folderLabel?: string
  selectMode: boolean
  selected: boolean
  pinned?: boolean
  onTogglePin: () => void
  onToggleSelect: () => void
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
  onMove: (folderId: string | null) => void
  onDragStartSelf: () => void
  onDragEndSelf: () => void
  readOnly?: boolean
}) {
  const navigate = useNavigate()
  const [menu, setMenu] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const anchored = useAnchoredPopover(triggerRef, menu, 224)
  const closeMenu = () => { setMenu(false); triggerRef.current?.focus({ preventScroll: true }) }
  useEffect(() => {
    if (!menu) return
    const onDoc = (event: MouseEvent) => {
      if (!anchored.popupRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setMenu(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(false); triggerRef.current?.focus({ preventScroll: true }) }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [menu, anchored.popupRef])
  useEffect(() => {
    if (menu && anchored.ready) firstActionRef.current?.focus({ preventScroll: true })
  }, [menu, anchored.ready])
  useEffect(() => { if (selectMode || readOnly) setMenu(false) }, [selectMode, readOnly])

  const types = flow.nodeTypes ?? []
  const shownTypes = types.slice(0, 7)
  const cardContent = <>
    {types.length > 0 && <span className="fl-flow-preview" aria-label={`노드 ${flow.nodeCount ?? types.length}개`}>
      {shownTypes.map((t, i) => <span key={i} className="fl-flow-preview-step">{i > 0 && <span className="fl-flow-preview-line" />}<NodeTypeIcon type={t} size={22} /></span>)}
      {types.length > shownTypes.length && <span className="fl-flow-preview-more">+{types.length - shownTypes.length}</span>}
      <span className="fl-flow-preview-count">노드 {flow.nodeCount ?? types.length}</span>
    </span>}
    <span className="fl-flow-identity">
      <span className="fl-flow-name" title={flow.name}>{flow.name}</span>
      {flow.description && <span className="fl-flow-description" title={flow.description}>{flow.description}</span>}
    </span>
    {folderLabel && <span className="fl-flow-folder" title={folderLabel}><AppIcon name="folder" size={13} /> {folderLabel}</span>}
  </>

  return (
    <article
      className="fl-flow-card"
      // 카드 어디를 눌러도 열린다(제목 링크만 클릭되던 문제). 버튼·입력·링크는 각자 동작.
      onClick={(event) => {
        if (!(event.target instanceof Element) || event.target.closest('a, button, input, select, label, [role="dialog"]')) return
        if (selectMode) onToggleSelect()
        else navigate(detailLink.to, { state: detailLink.state })
      }}
      data-selected={selected || undefined}
      aria-label={flow.name}
      draggable={!readOnly}
      onDragStart={(event) => {
        if (readOnly || !(event.target instanceof Element) || event.target.closest('button:not(.fl-flow-open),input,select')) { event.preventDefault(); return }
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', flow.name)
        onDragStartSelf()
      }}
      onDragEnd={onDragEndSelf}
    >
      <div className="fl-flow-card-top">
        {selectMode && <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={flow.name + ' 선택'} style={cardCheckbox} />}
        {selectMode
          ? <button className="fl-flow-open" onClick={onToggleSelect} aria-pressed={selected} aria-label={flow.name + ' 선택'}>{cardContent}</button>
          : <Link className="fl-flow-open" to={detailLink.to} state={detailLink.state} draggable={false}>{cardContent}</Link>}
      </div>
      <div className="fl-flow-footer">
        <div className="fl-flow-result">
          {lastRun ? <><StatusBadge status={lastRun.status} /><span title={lastRun.startedAt ? new Date(lastRun.startedAt).toLocaleString('ko-KR') : undefined}>{relTime(lastRun.startedAt)}</span></>
            : <span title={runState === 'ready' ? '이 공간의 최근 실행 50건 기준입니다.' : undefined}>{runState === 'loading' ? '최근 실행 확인 중…' : runState === 'error' ? '최근 실행을 확인하지 못했습니다' : '최근 실행 기록 없음'}</span>}
        </div>
        <div className="fl-flow-version" title={`v${flow.currentVersion} · 마지막 저장 ${new Date(flow.updatedAt).toLocaleString('ko-KR')}`}><time dateTime={flow.updatedAt}>{relTime(flow.updatedAt)} 저장</time></div>
        <div className="fl-flow-card-actions">
          <button onClick={onTogglePin} aria-label={flow.name + ' 즐겨찾기 ' + (pinned ? '해제' : '추가')} aria-pressed={!!pinned} title={pinned ? '즐겨찾기 해제' : '즐겨찾기 추가'} className="fl-flow-favorite" style={iconBtn}><AppIcon name="star" size={15} style={{ fill: pinned ? 'currentColor' : 'none' }} /></button>
          {!selectMode && !readOnly && <button ref={triggerRef} onClick={() => setMenu(value => !value)} aria-label={flow.name + ' 작업 메뉴'} aria-haspopup="dialog" aria-expanded={menu} title="작업" style={iconBtn}><AppIcon name="moreVertical" size={17} /></button>}
        </div>
      </div>
      {menu && createPortal(
        <div ref={anchored.popupRef} role="dialog" aria-label={flow.name + ' 작업'} style={{ ...menuBox, ...anchored.style }}
          onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== triggerRef.current) setMenu(false) }}>
          <button ref={firstActionRef} onClick={() => { closeMenu(); onRename() }} style={menuItem}>이름 바꾸기</button>
          <button onClick={() => { closeMenu(); onDuplicate() }} style={menuItem}><AppIcon name="copy" size={14} /> 복제</button>
          <label style={{ padding: '6px 5px 4px', fontSize: 12, color: 'var(--fl-text-muted)' }}>
            폴더로 이동
            <select aria-label={flow.name + ' 폴더 이동'} value={flow.folderId ?? ''} onChange={event => { onMove(event.target.value || null); closeMenu() }} style={menuSelect}>
              <option value="">미분류</option>
              {folderOptions.map(({ f: folder, depth }) => <option key={folder.id} value={folder.id}>{'  '.repeat(Math.min(depth, 8)) + (depth > 0 ? '└ ' : '') + folder.name}</option>)}
            </select>
          </label>
          <button onClick={() => { closeMenu(); onDelete() }} style={{ ...menuItem, color: 'var(--fl-fail)' }}><AppIcon name="trash" size={14} /> 삭제</button>
        </div>, document.body
      )}
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
function FolderTile({ folder, subCount, onOpen, drop, onDragStartSelf, onDragEndSelf, onRename, onDelete, readOnly }: {
  folder: FolderSummary
  subCount: number
  onOpen: () => void
  drop: DropSpec
  onDragStartSelf: () => void
  onDragEndSelf: () => void
  onRename: () => void
  onDelete: () => void
  readOnly?: boolean // viewer — 이름변경/삭제/드래그 숨김
}) {
  const [over, setOver] = useState(false)
  return (
    <article
      className="fl-folder-tile"
      draggable={!readOnly}
      onDragStart={(e) => {
        if (readOnly || !(e.target instanceof Element) || e.target.closest('.fl-folder-actions')) { e.preventDefault(); return }
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
        ...(over ? dropActive : null),
        ...(drop.dragging && drop.canDrop() && !over ? dropHint : null),
      }}
    >
      <button className="fl-folder-open" onClick={onOpen} title={`${folder.name} 폴더 열기`}>
        <AppIcon name="folder" size={28} style={{ fill: 'color-mix(in srgb, currentColor 18%, transparent)' }} />
        <span className="fl-folder-info">
          <span className="fl-folder-name">{folder.name}</span>
          <span className="fl-folder-count">워크플로 {folder.flowCount}{subCount > 0 ? ` · 폴더 ${subCount}` : ''}</span>
        </span>
        <AppIcon name="chevronRight" size={14} />
      </button>
      {!readOnly && (
        <div className="fl-folder-actions">
          <button onClick={onRename} aria-label={`${folder.name} 이름 변경`} title="이름 변경" style={miniBtn}>✎</button>
          <button onClick={onDelete} aria-label={`${folder.name} 삭제`} title="삭제" style={miniBtn}><AppIcon name="close" size={14} /></button>
        </div>
      )}
    </article>
  )
}

function CardSkeleton() {
  return (
    <div className="fl-flow-card" aria-hidden="true">
      <div style={{ height: 15, width: '55%', background: 'var(--fl-surface-2)', borderRadius: 6 }} />
      <div style={{ height: 9, width: 90, background: 'var(--fl-surface-2)', borderRadius: 6, marginTop: 12 }} />
      <div style={{ height: 20, width: 120, background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius-pill)', marginTop: 18 }} />
    </div>
  )
}

// ---------- 빈 상태 ----------

function EmptyState({ mode, canEdit, ready, creating, mockHref, onCreate, onClearSearch }: { mode: 'onboarding' | 'folder' | 'search'; canEdit: boolean; ready: boolean; creating: boolean; mockHref: string; onCreate: () => void; onClearSearch: () => void }) {
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
    <div style={{ ...emptyBox, padding: '32px 28px', display: 'grid', gap: 16, justifyItems: 'center' }}>
      <FlowGhost />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 18 }}>{canEdit ? '첫 워크플로를 만들어 보세요' : '아직 워크플로가 없습니다'}</div>
        <div style={{ color: 'var(--fl-text-muted)', fontSize: 14, marginTop: 6 }}>{canEdit ? 'HTTP 노드를 추가해 API를 호출하고, 실행 결과를 확인하세요. 기존 API는 cURL·OpenAPI로 가져올 수 있습니다.' : '이 공간은 읽기 전용입니다. 팀 편집자에게 생성을 요청하거나 관리자에게 편집 권한을 요청하세요.'}</div>
      </div>
      {canEdit && <><button onClick={onCreate} disabled={creating || !ready} style={primaryBtn}>{creating ? '만드는 중…' : '+ 새 워크플로'}</button><Link to={mockHref} style={{ fontSize: 13, color: 'var(--fl-primary)' }}>대상 API가 아직 없나요? HTTP Mock 만들기 →</Link></>}
    </div>
  )
}

// ---------- 사이드바 항목 ----------

function SidebarItem({ label, count, active, onClick, glyph, title, indent = 0, drop }: { label: string; count: number; active: boolean; onClick: () => void; glyph: ReactNode; title?: string; indent?: number; drop?: DropSpec }) {
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={drop ? (e) => { if (!drop.canDrop()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true) } : undefined}
      onDragLeave={drop ? () => setOver(false) : undefined}
      onDrop={drop ? (e) => { e.preventDefault(); setOver(false); drop.onDrop() } : undefined}
      style={{
        display: 'flex', alignItems: 'center', minWidth: 0, borderRadius: 'var(--fl-radius-sm)',
        background: over ? 'color-mix(in srgb, var(--fl-primary) 14%, var(--fl-surface))' : active ? 'var(--fl-surface-2)' : 'transparent',
        outline: over ? '1.5px dashed var(--fl-primary)' : 'none', outlineOffset: -1,
      }}>
      <button onClick={onClick} title={title ?? label} aria-current={active ? 'page' : undefined} style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 6px', paddingLeft: 8 + Math.min(indent, 3) * 8, border: 'none', background: 'transparent', cursor: 'pointer', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontWeight: active ? 600 : 500, fontSize: 14, textAlign: 'left' }}>
        <span aria-hidden style={{ width: 16, flexShrink: 0, textAlign: 'center' }}>{glyph}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--fl-text-muted)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </button>
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
        ...(over ? { color: 'var(--fl-primary)', outline: '1.5px dashed var(--fl-primary)', outlineOffset: 3, borderRadius: 'var(--fl-radius-sm)' } : null),
      }}
    >{label}</button>
  )
}

function Grid({ children, layout }: { children: ReactNode; layout: Layout }) {
  return <div className={layout === 'cards' ? 'fl-dashboard-grid' : 'fl-dashboard-list'}>{children}</div>
}

function isFolderId(s: Sel): s is string {
  return s !== 'all' && s !== 'none'
}

const sidebarLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '16px 8px 6px' }
const crumbBtn: CSSProperties = { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-xl)', fontWeight: 500, letterSpacing: '-.01em' }
const crumbCurrent: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 14, fontWeight: 600, letterSpacing: '-.01em', margin: 0 }
// 드래그 중 드롭 가능한 폴더 힌트(연한 점선) / 드래그오버 중 활성(강조)
const dropHint: CSSProperties = { border: '1px dashed color-mix(in srgb, var(--fl-primary) 45%, var(--fl-border))' }
const dropActive: CSSProperties = { border: '1.5px dashed var(--fl-primary)', background: 'color-mix(in srgb, var(--fl-primary) 10%, var(--fl-surface))', boxShadow: 'var(--fl-shadow-lg)' }
const bulkMoveSel: CSSProperties = { height: 32, padding: '0 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer' }
const newFolderBtn: CSSProperties = { ...ui.dashed, width: '100%', marginTop: 8 }
const primaryBtn: CSSProperties = { ...ui.primary }
const ghostBtn: CSSProperties = { ...ui.secondary }
const searchBox: CSSProperties = { padding: '0 12px 0 30px', height: 38, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, width: 240 }
const seg: CSSProperties = { display: 'flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', height: 38 }
const segBtn = (on: boolean): CSSProperties => ({ padding: '0 12px', border: 'none', background: on ? 'var(--fl-surface-2)' : 'transparent', color: on ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontSize: 13, fontWeight: on ? 600 : 500, cursor: 'pointer' })
const cardCheckbox: CSSProperties = { width: 18, height: 18, marginTop: 2, cursor: 'pointer', accentColor: 'var(--fl-primary)', flexShrink: 0 }
const selectToggleBtn = (on: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 6, height: 38, padding: '0 14px', borderRadius: 'var(--fl-radius-sm)', border: `1px solid ${on ? 'var(--fl-primary)' : 'var(--fl-border)'}`, background: on ? 'var(--fl-surface-2)' : 'var(--fl-surface)', color: on ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontSize: 13, fontWeight: on ? 600 : 500, cursor: 'pointer' })
const selectBar: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', borderRadius: 'var(--fl-radius-sm)', border: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }
const selectAllLabel: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fl-text)', cursor: 'pointer', userSelect: 'none' }
const dangerBtn = (disabled: boolean): CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--fl-action-danger-bg)', color: 'var(--fl-action-danger-ink)', border: 'none', padding: '8px 14px', borderRadius: 'var(--fl-radius)', fontWeight: 600, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, height: 36 })
const iconBtn: CSSProperties = { ...ui.icon, width: 30, height: 30 }
const miniBtn: CSSProperties = { ...ui.icon, width: 24, height: 28, flexShrink: 0 }
const menuBox: CSSProperties = { background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 100, display: 'grid', gap: 2 }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 'var(--fl-radius-sm)' }
const menuSelect: CSSProperties = { width: '100%', padding: '6px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13 }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 'var(--fl-radius)', padding: 40, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 14 }
const errorBox: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius)', padding: 18, color: 'var(--fl-text)' }
