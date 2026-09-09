import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { mocksApi } from '../api/client'
import type { MockServerSpec } from '../api/types'
import { diffMockSpecs, mockDiffSummary } from '../lib/mockDiff'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * Mock 정의 버전 기록 — 저장마다 쌓인 스냅샷을 열람·비교·복원(워크플로 버전 기록의 Mock 판).
 * 📌 커밋 바: 현재 편집 중 정의(미저장 포함)를 메시지 달아 보존 버전으로 저장(자동 정리에서 제외).
 */
export function MockVersionHistoryDialog({ mockId, currentSpec, readOnly, onClose, onRestored }: {
  mockId: string
  currentSpec: MockServerSpec
  readOnly?: boolean
  onClose: () => void
  onRestored: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<number | null>(null)
  const [msg, setMsg] = useState('')
  const versions = useQuery({ queryKey: ['mock-versions', mockId], queryFn: () => mocksApi.versions(mockId) })
  const preview = useQuery({ queryKey: ['mock-version', mockId, selected], queryFn: () => mocksApi.version(mockId, selected as number), enabled: selected != null })
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['mock-versions', mockId] }); qc.invalidateQueries({ queryKey: ['mock-server', mockId] }); qc.invalidateQueries({ queryKey: ['mock-servers'] }) }
  const restore = useMutation({
    mutationFn: (no: number) => mocksApi.restoreVersion(mockId, no),
    onSuccess: (v) => { toast(`v${v.versionNo}로 복원했습니다(서빙 즉시 반영).`, 'ok'); invalidate(); onRestored(); onClose() },
    onError: (e) => toast(`복원 실패: ${(e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '오류'}`, 'error'),
  })
  const commit = useMutation({
    mutationFn: () => mocksApi.updateSpec(mockId, currentSpec, { note: msg.trim() || undefined, pinned: true }),
    onSuccess: (d) => { toast(`📌 v${d.currentVersion ?? '?'} 보존 버전으로 저장했습니다${msg.trim() ? ` — "${msg.trim()}"` : ''}.`, 'ok'); setMsg(''); invalidate(); onRestored() },
    onError: (e) => toast(`보존 저장 실패: ${(e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '오류'}`, 'error'),
  })
  const pin = useMutation({
    mutationFn: (v: { no: number; pinned: boolean }) => mocksApi.pinVersion(mockId, v.no, v.pinned),
    onSuccess: (v) => { toast(v.pinned ? `📌 v${v.versionNo} 보존됨` : `v${v.versionNo} 보존 해제됨`, 'ok'); qc.invalidateQueries({ queryKey: ['mock-versions', mockId] }) },
  })
  const list = versions.data ?? []
  const current = list[0]?.versionNo
  const diff = preview.data ? diffMockSpecs(preview.data, currentSpec) : null
  const sel = list.find((v) => v.versionNo === selected)
  return (
    <Modal onClose={onClose} ariaLabel="Mock 버전 기록" width={760} maxWidth="94vw" height="min(560px, 86vh)">
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden>🕘</span>
        <strong style={{ flex: 1, fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>버전 기록</strong>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>저장마다 정의 스냅샷 · 최근 50개 유지(📌 보존은 영구)</span>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </header>
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !commit.isPending) commit.mutate() }}
            placeholder="보존 메시지 (예: 결제 승인 시나리오 완성)" aria-label="보존 버전 메시지"
            style={{ flex: 1, padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-bg)', color: 'var(--fl-text)', fontSize: 12.5 }} />
          <button onClick={() => commit.mutate()} disabled={commit.isPending} style={primary} title="현재 정의(미저장 편집 포함)를 저장하고 📌 보존">{commit.isPending ? '저장 중…' : '📌 보존 버전으로 저장'}</button>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ width: 270, flexShrink: 0, borderRight: '1px solid var(--fl-border)', overflowY: 'auto' }}>
          {versions.isLoading && <p style={pad}>불러오는 중…</p>}
          {!versions.isLoading && list.length === 0 && <p style={pad}>저장된 버전이 없습니다 — 저장하면 여기에 쌓입니다.</p>}
          {list.map((v) => (
            <button key={v.id} onClick={() => setSelected(v.versionNo)} style={{ ...row, ...(selected === v.versionNo ? rowSel : null) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <b style={{ fontSize: 13 }}>v{v.versionNo}</b>
                {v.versionNo === current && <span style={badge}>현재</span>}
                {v.pinned && <span style={pinBadge}>📌 보존</span>}
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{v.tcpPort != null ? `TCP :${v.tcpPort}` : `라우트 ${v.routeCount}`}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.note || '—'}</div>
              <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>{v.createdBy ? `${v.createdBy} · ` : ''}{fmt(v.createdAt)}</div>
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, padding: 18, overflowY: 'auto' }}>
          {selected == null ? <p style={{ color: 'var(--fl-text-muted)', fontSize: 13 }}>왼쪽에서 버전을 선택하면 현재 편집 중 정의와의 차이를 보여줍니다.</p>
            : preview.isLoading ? <p style={{ color: 'var(--fl-text-muted)' }}>불러오는 중…</p>
            : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <strong style={{ fontSize: 15 }}>v{selected}</strong>
                  {selected === current && <span style={badge}>현재 버전</span>}
                  {sel?.note && <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>— {sel.note}</span>}
                </div>
                <div style={diffBox}>
                  <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 6 }}>이 버전 → 현재 편집 중 정의 차이</div>
                  {diff && <div style={{ fontSize: 13, fontWeight: 600, color: diff.same ? 'var(--fl-text-muted)' : 'var(--fl-text)' }}>{mockDiffSummary(diff)}</div>}
                  {diff && !diff.same && (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--fl-text-muted)', display: 'grid', gap: 2 }}>
                      {diff.routes.added.map((r) => <li key={'a' + r}><span style={{ color: 'var(--fl-ok)' }}>+</span> {r}</li>)}
                      {diff.routes.removed.map((r) => <li key={'r' + r}><span style={{ color: 'var(--fl-fail)' }}>−</span> {r}</li>)}
                      {diff.routes.changed.map((r) => <li key={'c' + r}><span style={{ color: 'var(--fl-primary)' }}>~</span> {r}</li>)}
                    </ul>
                  )}
                </div>
                {preview.data && (
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ fontSize: 12, color: 'var(--fl-text-muted)', cursor: 'pointer' }}>이 버전 JSON 보기</summary>
                    <pre style={pre}>{JSON.stringify(preview.data, null, 2)}</pre>
                  </details>
                )}
                {!readOnly && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                    <button onClick={() => pin.mutate({ no: selected, pinned: !sel?.pinned })} style={ghost}>{sel?.pinned ? '📌 보존 해제' : '📌 이 버전 보존'}</button>
                    {selected !== current && (
                      <button onClick={() => restore.mutate(selected)} disabled={restore.isPending} style={primary} title="이 스냅샷을 새 버전으로 저장하고 서빙에 즉시 반영">↩ 이 버전으로 복원</button>
                    )}
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </Modal>
  )
}

function fmt(iso: string): string { try { return new Date(iso).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return iso } }

const xBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
const pad: CSSProperties = { padding: 14, fontSize: 12.5, color: 'var(--fl-text-muted)' }
const row: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer' }
const rowSel: CSSProperties = { background: 'var(--fl-surface-2)', boxShadow: 'inset 3px 0 0 var(--fl-primary)' }
const badge: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--fl-primary)', color: '#fff' }
const pinBadge: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--fl-border)', color: 'var(--fl-text-muted)' }
const diffBox: CSSProperties = { padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
const pre: CSSProperties = { margin: '6px 0 0', padding: 10, fontSize: 11, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 6, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }
const primary: CSSProperties = { padding: '8px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const ghost: CSSProperties = { padding: '8px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
