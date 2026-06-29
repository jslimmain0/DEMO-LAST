import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { asGraphNode } from './graphAdapter'
import { catColor, typeIcon } from './nodeMeta'

// IF 분기 노드 — true/false 두 source 핸들. fromPort='true'|'false' 라운드트립.
export function BranchNode({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const accent = catColor('if')
  return (
    <div
      style={{
        minWidth: 200,
        background: 'var(--fl-surface)',
        border: `1px solid ${selected ? 'var(--fl-cat-if)' : 'var(--fl-border)'}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        fontFamily: 'var(--fl-font-ui)',
        position: 'relative',
      }}
    >
      <Handle type="target" position={Position.Left} className="fl-handle" style={{ borderColor: 'var(--fl-cat-if)' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderLeft: `3px solid ${accent}` }}>
        <span aria-hidden style={{ color: accent, fontSize: 14, width: 16, textAlign: 'center' }}>{typeIcon('if')}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{n.name ?? 'IF 조건'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.condition || '조건 없음'}
          </div>
        </div>
      </div>

      <div style={{ position: 'absolute', right: -6, top: '34%', fontSize: 9, fontWeight: 700, color: 'var(--fl-ok)' }}>T</div>
      <div style={{ position: 'absolute', right: -6, top: '64%', fontSize: 9, fontWeight: 700, color: 'var(--fl-fail)' }}>F</div>
      <Handle id="true" type="source" position={Position.Right} className="fl-handle" style={{ top: '38%', borderColor: 'var(--fl-ok)' }} />
      <Handle id="false" type="source" position={Position.Right} className="fl-handle" style={{ top: '68%', borderColor: 'var(--fl-fail)' }} />
    </div>
  )
}
