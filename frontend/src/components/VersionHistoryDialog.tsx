import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { flowsApi } from '../api/client'
import type { FlowGraph } from '../api/types'
import { diffGraphs, diffSummary } from '../lib/graphDiff'
import { toast } from './toast'
import { Modal } from './Modal'
import { useEditorStore } from '../store/editorStore'

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
  const [commitMsg, setCommitMsg] = useState('')
  const readOnly = useEditorStore((s) => s.readOnly) // 워크스페이스 VIEWER — 커밋/보존/복원 숨김

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

  // 📌 커밋 — 현재 캔버스를 메시지 달아 보존 버전으로 저장(자동 정리에서 영구 제외).
  // 미저장 편집도 이 스냅샷에 포함되므로 사실상 "메시지 있는 저장 + 영구 보존".
  const commit = useMutation({
    mutationFn: () => flowsApi.saveVersion(flowId, { graph: currentGraph, note: commitMsg.trim() || undefined, pinned: true }),
    onSuccess: (v) => {
      toast(`📌 v${v.versionNo} 보존 버전으로 저장했습니다${commitMsg.trim() ? ` — "${commitMsg.trim()}"` : ''}.`, 'ok')
      setCommitMsg('')
      qc.invalidateQueries({ queryKey: ['flow', flowId] })
      qc.invalidateQueries({ queryKey: ['flow-versions', flowId] })
      onRestored() // 에디터가 flow 를 재조회해 dirty/버전 상태 동기화
    },
    onError: (e) => toast(`보존 저장 실패: ${(e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '오류'}`, 'error'),
  })

  const pin = useMutation({
    mutationFn: (v: { no: number; pinned: boolean }) => flowsApi.pinVersion(flowId, v.no, v.pinned),
    onSuccess: (v) => {
      toast(v.pinned ? `📌 v${v.versionNo} 보존됨 — 자동 정리에서 제외됩니다` : `v${v.versionNo} 보존 해제됨`, 'ok')
      qc.invalidateQueries({ queryKey: ['flow-versions', flowId] })
    },
    onError: () => toast('보존 상태 변경에 실패했습니다.', 'error'),
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

        {/* 📌 커밋 바 — 현재 캔버스를 메시지 달아 보존 버전으로(자동 정리에서 영구 제외) */}
        {!readOnly && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 18px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !commit.isPending) commit.mutate() }}
              placeholder="보존 메시지 (예: v1.2 배포 직전 상태)"
              aria-label="보존 버전 메시지"
              style={{ flex: 1, padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-bg)', color: 'var(--fl-text)', fontSize: 12.5 }}
            />
            <button onClick={() => commit.mutate()} disabled={commit.isPending}
              title="현재 캔버스(미저장 편집 포함)를 새 버전으로 저장하고 📌 보존 — 자동 정리에서 절대 삭제되지 않습니다"
              style={{ ...primary, padding: '8px 14px', whiteSpace: 'nowrap' }}>
              {commit.isPending ? '저장 중…' : '📌 보존 버전으로 저장'}
            </button>
          </div>
        )}

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
                  {v.pinned && <span title="보존 버전 — 자동 정리에서 제외" style={pinBadge}>📌 보존</span>}
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
                  {!readOnly && (
                    <button
                      onClick={() => restore.mutate(selected)}
                      disabled={restore.isPending || selected === current}
                      title={selected === current ? '이미 현재 버전입니다' : '이 버전을 새 버전으로 복원'}
                      style={{ ...primary, opacity: selected === current || restore.isPending ? 0.5 : 1 }}
                    >
                      ↩ 이 버전으로 복원
                    </button>
                  )}
                  {!readOnly && (() => {
                    const sel = list.find((x) => x.versionNo === selected)
                    return (
                      <button
                        onClick={() => pin.mutate({ no: selected, pinned: !sel?.pinned })}
                        disabled={pin.isPending}
                        title={sel?.pinned ? '보존 해제 — 오래되면 자동 정리 대상으로 돌아갑니다' : '보존 — 자동 정리에서 영구 제외'}
                        style={{ ...primary, background: 'transparent', border: '1px solid var(--fl-border)', color: sel?.pinned ? 'var(--fl-waiting)' : 'var(--fl-text)' }}
                      >
                        {sel?.pinned ? '📌 보존 해제' : '📌 이 버전 보존'}
                      </button>
                    )
                  })()}
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
const pinBadge: CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--fl-waiting)', border: '1px solid var(--fl-waiting)', borderRadius: 8, padding: '0 6px', whiteSpace: 'nowrap' }
const badge: CSSProperties = { fontSize: 10, fontWeight: 700, color: 'var(--fl-primary)', border: '1px solid var(--fl-primary)', borderRadius: 8, padding: '0 6px' }
const diffBox: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface-2)' }
const primary: CSSProperties = { padding: '9px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
