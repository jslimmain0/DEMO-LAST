import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { HttpMethod } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { asGraphNode } from './graphAdapter'
import { catColor, typeIcon, typeLabel } from './nodeMeta'

const handleStyle = {
  width: 10,
  height: 10,
  background: 'var(--fl-surface)',
  border: '2px solid var(--fl-primary)',
}

export function NodeCard({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const accent = catColor(n.cat)
  const isStart = n.type === 'start'
  const isEnd = n.type === 'end'
  const isHttp = n.type === 'http'

  return (
    <div
      style={{
        minWidth: 200,
        background: 'var(--fl-surface)',
        border: `1px solid ${selected ? 'var(--fl-primary)' : 'var(--fl-border)'}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        overflow: 'hidden',
        fontFamily: 'var(--fl-font-ui)',
      }}
    >
      {!isStart && <Handle type="target" position={Position.Left} style={handleStyle} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderLeft: `3px solid ${accent}` }}>
        <span aria-hidden style={{ color: accent, fontSize: 14, width: 16, textAlign: 'center' }}>{typeIcon(n.type)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.name ?? typeLabel(n.type)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>
            {typeLabel(n.type)}
          </div>
        </div>
      </div>

      {isHttp && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderTop: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)' }}>
          <MethodTag method={(n.method ?? 'GET') as HttpMethod} />
          <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.path || '/'}
          </span>
        </div>
      )}

      {!isEnd && <Handle type="source" id="out" position={Position.Right} style={handleStyle} />}
    </div>
  )
}
