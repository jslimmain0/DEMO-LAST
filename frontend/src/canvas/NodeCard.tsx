import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { HttpMethod } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { catColor, typeIcon, typeLabel } from './nodeMeta'

export function NodeCard({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const waiting = useEditorStore((s) => s.waitingNodeId) === n.id
  const accent = catColor(n.cat)
  const isStart = n.type === 'start'
  const isEnd = n.type === 'end'
  const isHttp = n.type === 'http'

  return (
    <div
      style={{
        minWidth: 200,
        background: 'var(--fl-surface)',
        border: `1px solid ${waiting ? 'var(--fl-waiting)' : selected ? 'var(--fl-primary)' : 'var(--fl-border)'}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        overflow: 'hidden',
        fontFamily: 'var(--fl-font-ui)',
      }}
    >
      {!isStart && <Handle type="target" position={Position.Left} className="fl-handle" />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderLeft: `3px solid ${accent}` }}>
        <span aria-hidden style={{ color: accent, fontSize: 14, width: 16, textAlign: 'center' }}>{typeIcon(n.type)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.name ?? typeLabel(n.type)}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>
            {waiting ? '콜백 대기 중…' : typeLabel(n.type)}
          </div>
        </div>
        {waiting && <span className="fl-wait-dot" title="콜백 대기 중" aria-label="콜백 대기 중" />}
      </div>

      {isHttp && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderTop: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
          <MethodTag method={(n.method ?? 'GET') as HttpMethod} />
          <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.path || '/'}
          </span>
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
