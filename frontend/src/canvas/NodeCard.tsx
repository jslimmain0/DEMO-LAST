import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { HttpMethod } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { getReachableCached } from '../lib/reachable'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { catColor, typeIcon, typeLabel } from './nodeMeta'

export function NodeCard({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const waitingId = useEditorStore((s) => s.waitingNodeId)
  const runState = useEditorStore((s) => s.runView?.nodeStates[n.id])
  // 시작에서 도달 못 하는 실행 노드 = 실행 시 건너뜀. 실행 전에 점선 테두리로 미리 표시.
  const unreachable = useEditorStore((s) => {
    if (n.type === 'start' || n.type === 'note' || n.type === 'group') return false
    if (!s.nodes.some((x) => (x.data as { type?: string } | undefined)?.type === 'start')) return false
    return !getReachableCached(s.nodes, s.edges).has(n.id)
  })
  const waiting = waitingId === n.id || runState === 'waiting'
  const running = runState === 'running'
  const accent = catColor(n.cat)
  const isStart = n.type === 'start'
  const isEnd = n.type === 'end'
  const isHttp = n.type === 'http'

  const showUnreachable = unreachable && !selected && !runState && !waiting && !running
  const borderColor = waiting
    ? 'var(--fl-waiting)'
    : running
      ? 'var(--fl-running)'
      : runState === 'failed'
        ? 'var(--fl-fail)'
        : selected
          ? 'var(--fl-primary)'
          : runState === 'success'
            ? 'var(--fl-ok)'
            : showUnreachable
              ? 'var(--fl-put)'
              : 'var(--fl-border)'

  return (
    <div
      className={running ? 'fl-node-running' : undefined}
      style={{
        width: 230, // 고정 폭 — URL/이름이 길어도 늘어나지 않는다(말줄임). fitBounds NODE_W 와 일치
        background: 'var(--fl-surface)',
        border: `1px ${showUnreachable ? 'dashed' : 'solid'} ${borderColor}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        overflow: 'hidden',
        fontFamily: 'var(--fl-font-ui)',
        opacity: runState === 'skipped' ? 0.55 : 1,
      }}
    >
      {!isStart && <Handle type="target" position={Position.Left} className="fl-handle" />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderLeft: `3px solid ${accent}` }}>
        <span aria-hidden style={{ color: accent, fontSize: 14, width: 16, textAlign: 'center' }}>{typeIcon(n.type)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.name ?? typeLabel(n.type)}
          </div>
          <div style={{ fontSize: 11.5, color: showUnreachable ? 'var(--fl-put)' : 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', fontWeight: showUnreachable ? 600 : 400 }}>
            {waiting ? '콜백 대기 중…' : running ? '실행 중…' : runState === 'skipped' ? '건너뜀' : showUnreachable ? '⚠ 미연결' : typeLabel(n.type)}
          </div>
        </div>
        <RunBadge state={waiting ? 'waiting' : runState} />
      </div>

      {isHttp && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderTop: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
          <MethodTag method={(n.method ?? 'GET') as HttpMethod} />
          <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.path || '/'}
          </span>
          {n.method && n.method !== 'GET' && n.method !== 'HEAD' && (
            <span title={`본문 종류: ${n.bodyType ?? 'json'}`} style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 700, fontFamily: 'var(--fl-font-mono)', padding: '2px 5px', borderRadius: 'var(--fl-radius-pill)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)' }}>
              {(n.bodyType === 'form' || n.bodyType === 'urlencoded') ? 'FORM' : (n.bodyType ?? 'json').toUpperCase()}
            </span>
          )}
          {(() => {
            const client = n.reqMode === 'client'
            return (
              <span
                title={client ? '클라이언트 → 서버 (브라우저에서 직접 호출)' : '서버 → 서버 (서버가 대신 호출)'}
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: 'var(--fl-font-mono)',
                  padding: '2px 6px',
                  borderRadius: 'var(--fl-radius-pill)',
                  color: client ? '#0ea5a4' : 'var(--fl-primary)',
                  background: client ? 'rgba(14,165,164,.12)' : 'rgba(97,85,245,.12)',
                }}
              >
                {client ? 'C→S' : 'S→S'}
              </span>
            )
          })()}
        </div>
      )}

      {!isEnd && <Handle type="source" id="out" position={Position.Right} className="fl-handle" />}
    </div>
  )
}

/** 실행 경과 배지 — 진행 중 스피너 / 성공 ✓ / 실패 ✕ / 건너뜀 ⊘ / 대기 펄스. (role=img 로 보조기기 노출) */
export function RunBadge({ state }: { state?: string }) {
  if (state === 'waiting') return <span role="img" className="fl-wait-dot" title="콜백 대기 중" aria-label="콜백 대기 중" />
  if (state === 'running') return <span role="img" className="fl-run-spinner" title="실행 중" aria-label="실행 중" />
  if (state === 'success') return <span role="img" className="fl-run-badge" style={{ color: 'var(--fl-ok)' }} title="성공" aria-label="성공">✓</span>
  if (state === 'failed') return <span role="img" className="fl-run-badge" style={{ color: 'var(--fl-fail)' }} title="실패" aria-label="실패">✕</span>
  if (state === 'skipped') return <span role="img" className="fl-run-badge" style={{ color: 'var(--fl-text-muted)' }} title="건너뜀" aria-label="건너뜀">⊘</span>
  return null
}
