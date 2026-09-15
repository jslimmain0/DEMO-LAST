// frontend/src/routes/Protocols.tsx — 프로토콜(고정길이 전문 규격) 목록 + 편집기.
// 선택 상태는 URL(/protocols/:id) 이라 새로고침·딥링크가 유지된다(TCP 노드·Mock 의 "관리 →" 가 직행).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { protocolsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { usePermissions } from '../auth/AuthContext'
import { ProtocolEditor } from '../components/ProtocolEditor'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { newProtocolSpec } from '../lib/protocolSpec'

export function Protocols() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { canEdit } = usePermissions()
  const [q, setQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const list = useQuery({ queryKey: ['protocols'], queryFn: protocolsApi.list })
  const detail = useQuery({ queryKey: ['protocol', id], queryFn: () => protocolsApi.get(id!), enabled: !!id })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['protocols'] })
    if (id) qc.invalidateQueries({ queryKey: ['protocol', id] })
  }
  const create = useMutation({
    mutationFn: () => protocolsApi.create(`새 프로토콜 ${(list.data?.length ?? 0) + 1}`, newProtocolSpec()),
    onSuccess: (d) => { invalidate(); navigate(`/protocols/${d.id}`) },
    onError: (e) => toast(apiErrorMessage(e), 'error'),
  })

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

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (list.data ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle))
  }, [list.data, q])

  return (
    <AppShellTier1>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', height: '100dvh', overflow: 'hidden' }}>
        <aside style={listPane}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 2px' }}>
            <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 18, margin: 0 }}>프로토콜</h1>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{list.data?.length ?? 0}</span>
          </div>
          <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색 ( / )" aria-label="프로토콜 검색"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} style={search} />
          {canEdit && (
            <button onClick={() => create.mutate()} disabled={create.isPending} style={primaryBtn}>
              {create.isPending ? '만드는 중…' : '+ 새 프로토콜'}
            </button>
          )}
          <div style={{ overflowY: 'auto', display: 'grid', gap: 3, alignContent: 'start' }}>
            {list.isLoading && <div style={muted}>불러오는 중…</div>}
            {list.isError && <div style={{ ...muted, color: 'var(--fl-fail)' }}>목록을 불러오지 못했습니다.</div>}
            {list.data && !items.length && <div style={muted}>{q ? '일치하는 프로토콜이 없습니다.' : '아직 프로토콜이 없습니다.'}</div>}
            {items.map((p) => (
              <button key={p.id} onClick={() => navigate(`/protocols/${p.id}`)} style={{ ...item, ...(p.id === id ? itemOn : null) }}>
                <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{p.encoding} · 전문 {p.messageCount}</span>
              </button>
            ))}
          </div>
        </aside>

        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          {!id ? (
            <div style={empty}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>프로토콜</div>
              <p style={{ maxWidth: 460, margin: '8px auto 0', fontSize: 13.5, lineHeight: 1.6 }}>
                왼쪽에서 프로토콜을 고르거나 새로 만드세요. 한 번 정의하면 TCP 노드·TCP Mock 이 같이 씁니다.
              </p>
            </div>
          ) : detail.isLoading ? (
            <div style={empty}>불러오는 중…</div>
          ) : detail.isError ? (
            <div style={{ ...empty, color: 'var(--fl-fail)' }}>{apiErrorMessage(detail.error)}</div>
          ) : detail.data ? (
            <ProtocolEditor key={detail.data.id} detail={detail.data} canEdit={canEdit} onSaved={invalidate} />
          ) : null}
        </div>
      </div>
    </AppShellTier1>
  )
}

const listPane: CSSProperties = { display: 'grid', gridTemplateRows: 'auto auto auto 1fr', gap: 8, padding: '18px 14px', borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', minHeight: 0 }
const search: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const primaryBtn: CSSProperties = { padding: '8px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }
const item: CSSProperties = { display: 'grid', gap: 2, textAlign: 'left', padding: '8px 10px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', minWidth: 0 }
const itemOn: CSSProperties = { background: 'var(--fl-surface-2)', borderColor: 'var(--fl-border)' }
const muted: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', padding: '6px 2px' }
const empty: CSSProperties = { height: '100%', display: 'grid', alignContent: 'center', justifyItems: 'center', textAlign: 'center', color: 'var(--fl-text-muted)', padding: 40 }
