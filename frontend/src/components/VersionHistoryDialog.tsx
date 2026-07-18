import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { flowsApi } from '../api/client'
import type { FlowGraph } from '../api/types'
import { diffGraphs, diffSummary } from '../lib/graphDiff'
import { toast } from './toast'
import { Modal } from './Modal'

/**
 * 버전 기록 — 저장 때마다 쌓인 불변 스냅샷(FlowVersion)을 열람·비교·복원.
 * 선택한 버전과 현재 캔버스 그래프의 요약 diff(노드/연결 added/removed/changed)를 보여주고,
 * '이 버전으로 복원'은 그 스냅샷을 **새 버전으로** 저장(이력 보존)한 뒤 캔버스를 갱신한다.
 */
export function VersionHistoryDialog({
  flowId,
  currentGraph,
  onClose,
  onRestored,
}: {
  flowId: string
  currentGraph: FlowGraph
  onClose: () => void
  onRestored: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<number | null>(null)

  const versions = useQuery({ queryKey: ['flow-versions', flowId], queryFn: () => flowsApi.listVersions(flowId) })
  const preview = useQuery({
    queryKey: ['flow-version', flowId, selected],
    queryFn: () => flowsApi.getVersion(flowId, selected as number),
    enabled: selected != null,
  })

  const restore = useMutation({
    mutationFn: (no: number) => flowsApi.restoreVersion(flowId, no),
    onSuccess: (v) => {
      toast(`v${v.versionNo}로 복원했습니다.`, 'ok')
      qc.invalidateQueries({ queryKey: ['flow', flowId] })
      qc.invalidateQueries({ queryKey: ['flow-versions', flowId] })
      onRestored()
      onClose()
    },
    onError: () => toast('복원에 실패했습니다.', 'error'),
  })

  const list = versions.data ?? []
  const current = list[0]?.versionNo // 최신 = 현재 버전
  const diff = preview.data ? diffGraphs(preview.data, currentGraph) : null

  return (
    <Modal onClose={onClose} ariaLabel="버전 기록" width={760} maxWidth="94vw" height="min(560px, 86vh)">
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <span aria-hidden>🕘</span>
          <strong style={{ flex: 1, fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>버전 기록</strong>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* 버전 목록 */}
          <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid var(--fl-border)', overflowY: 'auto' }}>
            {versions.isLoading && <p style={pad}>불러오는 중…</p>}
            {versions.isError && <p style={{ ...pad, color: 'var(--fl-fail)' }}>목록을 불러오지 못했습니다.</p>}
            {!versions.isLoading && list.length === 0 && <p style={pad}>저장된 버전이 없습니다.</p>}
            {list.map((v) => (
              <button
                key={v.id}
                onClick={() => setSelected(v.versionNo)}
                style={{ ...row, ...(selected === v.versionNo ? rowSel : null) }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <b style={{ fontSize: 13 }}>v{v.versionNo}</b>
                  {v.versionNo === current && <span style={badge}>현재</span>}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.note || '—'}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', marginTop: 2 }}>
                  {v.createdBy ? `${v.createdBy} · ` : ''}{fmt(v.createdAt)}
                </div>
              </button>
            ))}
          </div>

          {/* 선택 버전 상세 + diff */}
          <div style={{ flex: 1, minWidth: 0, padding: 18, overflowY: 'auto' }}>
            {selected == null ? (
              <p style={{ color: 'var(--fl-text-muted)', fontSize: 13 }}>왼쪽에서 버전을 선택하면 현재 캔버스와의 차이를 보여줍니다.</p>
            ) : preview.isLoading ? (
              <p style={{ color: 'var(--fl-text-muted)' }}>불러오는 중…</p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <strong style={{ fontSize: 15 }}>v{selected}</strong>
                  {selected === current && <span style={badge}>현재 버전</span>}
                </div>
                <div style={diffBox}>
                  <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 6 }}>이 버전 → 현재 캔버스 차이</div>
                  {diff && (
                    <div style={{ fontSize: 13, fontWeight: 600, color: diff.same ? 'var(--fl-text-muted)' : 'var(--fl-text)' }}>
                      {diffSummary(diff)}
                    </div>
                  )}
                  {diff && !diff.same && (
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.7 }}>
                      {diff.nodesAdded.length > 0 && <li>현재에만 있는 노드: {diff.nodesAdded.length}개</li>}
                      {diff.nodesRemoved.length > 0 && <li>이 버전에만 있는 노드: {diff.nodesRemoved.length}개</li>}
                      {diff.nodesChanged.length > 0 && <li>내용이 다른 노드: {diff.nodesChanged.length}개</li>}
                    </ul>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 12 }}>
                  노드 {preview.data?.nodes?.length ?? 0}개 · 연결 {preview.data?.edges?.length ?? 0}개
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button
                    onClick={() => restore.mutate(selected)}
                    disabled={restore.isPending || selected === current}
                    title={selected === current ? '이미 현재 버전입니다' : '이 버전을 새 버전으로 복원'}
                    style={{ ...primary, opacity: selected === current || restore.isPending ? 0.5 : 1 }}
                  >
                    ↩ 이 버전으로 복원
                  </button>
                </div>
                {selected === current && <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>현재 버전은 복원할 필요가 없습니다.</p>}
              </>
            )}
          </div>
        </div>
      </Modal>
  )
}

function fmt(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return iso }
}

const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const pad: CSSProperties = { padding: 16, fontSize: 12.5, color: 'var(--fl-text-muted)' }
const row: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', border: 'none', borderBottom: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer' }
const rowSel: CSSProperties = { background: 'var(--fl-surface-2)' }
const badge: CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--fl-primary)', border: '1px solid var(--fl-primary)', borderRadius: 8, padding: '0 6px' }
const diffBox: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface-2)' }
const primary: CSSProperties = { padding: '9px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
