import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { FlowSummary, FolderSummary } from '../api/types'
import { flowsApi, foldersApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { initial, relTime } from '../lib/format'

type Sel = 'all' | 'none' | string // 'all' | 'none' | folderId
type Sort = 'recent' | 'name'

export function Dashboard() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const flows = useQuery({ queryKey: ['flows'], queryFn: flowsApi.list })
  const folders = useQuery({ queryKey: ['folders'], queryFn: foldersApi.list })

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

  return (
    <AppShellTier1>
      <div style={{ display: 'flex', minHeight: 'calc(100dvh - 65px)' }}>
        {/* 폴더 사이드바 */}
        <aside aria-label="폴더" style={sidebar}>
          <FolderItem label="전체 워크플로" count={allFlows.length} active={sel === 'all'} onClick={() => setSel('all')} icon="▦" />
          <FolderItem label="미분류" count={noneCount} active={sel === 'none'} onClick={() => setSel('none')} icon="◇" />
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '16px 8px 6px' }}>폴더</div>
          {folderList.map((f) => (
            <FolderItem
              key={f.id}
              label={f.name}
              count={f.flowCount}
              active={sel === f.id}
              onClick={() => setSel(f.id)}
              icon="📁"
              onRename={() => { const n = prompt('폴더 이름', f.name); if (n && n.trim()) renameFolder.mutate({ id: f.id, name: n.trim() }) }}
              onDelete={() => { if (confirm(`'${f.name}' 폴더를 삭제할까요? 안의 워크플로는 미분류로 옮겨집니다.`)) removeFolder.mutate(f.id) }}
            />
          ))}
          <button onClick={() => { const n = prompt('새 폴더 이름'); if (n && n.trim()) createFolder.mutate(n.trim()) }} style={newFolderBtn}>+ 새 폴더</button>
        </aside>

        {/* 본문 */}
        <div style={{ flex: 1, minWidth: 0, padding: '32px 40px 80px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22, flexWrap: 'wrap' }}>
            <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>
              {sel === 'all' ? '전체 워크플로' : sel === 'none' ? '미분류' : folderList.find((f) => f.id === sel)?.name ?? '워크플로'}
            </h1>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔍 검색…" style={searchBox} />
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} style={sortSel}>
              <option value="recent">최근 수정순</option>
              <option value="name">이름순</option>
            </select>
            <button onClick={() => createFlow.mutate()} disabled={createFlow.isPending} style={primaryBtn}>+ 새 워크플로</button>
          </div>

          {flows.isLoading && <Grid>{[0, 1, 2, 3].map((i) => <div key={i} style={{ ...card, height: 120, opacity: 0.5 }} />)}</Grid>}
          {flows.isError && <div style={errorBox}>⚠ 백엔드(18080) 연결 실패 — 백엔드를 먼저 띄우세요.</div>}
          {flows.data && visible.length === 0 && (
            <div style={emptyBox}>{search ? '검색 결과가 없습니다.' : '워크플로가 없습니다. "새 워크플로"로 시작하세요.'}</div>
          )}

          {visible.length > 0 && (
            <Grid>
              {visible.map((f) => (
                <article key={f.id} style={card}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                      <span aria-hidden style={avatar}>{initial(f.name)}</span>
                      <div style={{ minWidth: 0 }}>
                        <Link to={`/flows/${f.id}`} style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 15.5, color: 'var(--fl-text)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</Link>
                        <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>v{f.currentVersion} · {relTime(f.updatedAt) || '방금'}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button onClick={() => duplicateFlow.mutate(f)} title="복제" aria-label={`${f.name} 복제`} style={iconBtn}>⧉</button>
                      <button onClick={() => { if (confirm(`'${f.name}' 워크플로를 삭제할까요? 되돌릴 수 없습니다.`)) removeFlow.mutate(f.id) }} title="삭제" aria-label={`${f.name} 삭제`} style={iconBtn}>🗑</button>
                    </div>
                  </div>
                  {f.description && <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--fl-text-muted)', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{f.description}</p>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 14 }}>
                    <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>폴더</span>
                    <select
                      aria-label="폴더 이동"
                      value={f.folderId ?? ''}
                      onChange={(e) => moveFlow.mutate({ id: f.id, folderId: e.target.value || null })}
                      style={moveSel}
                    >
                      <option value="">미분류</option>
                      {folderList.map((fo) => <option key={fo.id} value={fo.id}>{fo.name}</option>)}
                    </select>
                  </div>
                </article>
              ))}
            </Grid>
          )}
        </div>
      </div>
    </AppShellTier1>
  )
}

function FolderItem({ label, count, active, onClick, icon, onRename, onDelete }: { label: string; count: number; active: boolean; onClick: () => void; icon: string; onRename?: () => void; onDelete?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', borderRadius: 'var(--fl-radius-sm)', background: active ? 'var(--fl-surface-2)' : 'transparent' }}>
      <button onClick={onClick} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', border: 'none', background: 'transparent', cursor: 'pointer', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', fontWeight: active ? 600 : 500, fontSize: 13.5, textAlign: 'left' }}>
        <span aria-hidden style={{ width: 18 }}>{icon}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{count}</span>
      </button>
      {onRename && <button onClick={onRename} aria-label="이름 변경" title="이름 변경" style={miniBtn}>✎</button>}
      {onDelete && <button onClick={onDelete} aria-label="삭제" title="삭제" style={miniBtn}>×</button>}
    </div>
  )
}

function Grid({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 380px))', justifyContent: 'start', gap: 16 }}>{children}</div>
}

function isFolderId(s: Sel): s is string {
  return s !== 'all' && s !== 'none'
}

const sidebar: CSSProperties = { width: 232, flexShrink: 0, borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', padding: 14, overflowY: 'auto' }
const newFolderBtn: CSSProperties = { width: '100%', marginTop: 8, padding: '8px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }
const primaryBtn: CSSProperties = { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, background: 'var(--fl-text)', color: 'var(--fl-bg)', border: 'none', padding: '10px 16px', borderRadius: 11, fontWeight: 600, fontSize: 14, cursor: 'pointer' }
const searchBox: CSSProperties = { padding: '9px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, width: 220 }
const sortSel: CSSProperties = { padding: '9px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13 }
const card: CSSProperties = { background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', padding: '20px 20px 16px', boxShadow: 'var(--fl-shadow)' }
const avatar: CSSProperties = { width: 38, height: 38, flexShrink: 0, borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--fl-primary) 14%, transparent)', color: 'var(--fl-primary)', fontFamily: 'var(--fl-font-head)', fontWeight: 700 }
const iconBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', cursor: 'pointer', color: 'var(--fl-text-muted)' }
const miniBtn: CSSProperties = { width: 24, height: 28, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
const moveSel: CSSProperties = { flex: 1, padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12 }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: 48, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 14 }
const errorBox: CSSProperties = { border: '1px solid var(--fl-fail)', borderRadius: 12, padding: 20, color: 'var(--fl-fail)', fontSize: 14 }
