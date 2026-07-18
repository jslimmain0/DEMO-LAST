import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { NODE_W, catColor, typeIcon } from './nodeMeta'
import { RunBadge } from './NodeCard'

// IF 분기 노드 — true/false 두 source 핸들. fromPort='true'|'false' 라운드트립.
export function BranchNode({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const runState = useEditorStore((s) => s.runView?.nodeStates[n.id])
  const running = runState === 'running'
  const accent = catColor('if')
  const borderColor = running
    ? 'var(--fl-running)'
    : runState === 'failed'
      ? 'var(--fl-fail)'
      : selected
        ? 'var(--fl-cat-if)'
        : runState === 'success'
          ? 'var(--fl-ok)'
          : 'var(--fl-border)'
  return (
    <div
      className={running ? 'fl-node-running' : undefined}
      style={{
        width: NODE_W, // NodeCard 와 동일 고정 폭
        background: 'var(--fl-surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        fontFamily: 'var(--fl-font-ui)',
        position: 'relative',
        opacity: runState === 'skipped' ? 0.55 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} className="fl-handle" style={{ borderColor: 'var(--fl-cat-if)' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderLeft: `3px solid ${accent}` }}>
        <span aria-hidden style={{ color: accent, fontSize: 14, width: 16, textAlign: 'center' }}>{typeIcon('if')}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{n.name ?? 'IF 조건'}</div>
          <div title={n.condition || '조건 없음'} style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {n.condition || '조건 없음'}
          </div>
        </div>
        <RunBadge state={runState} />
      </div>

      <div style={{ position: 'absolute', right: -6, top: '34%', fontSize: 9, fontWeight: 700, color: 'var(--fl-ok)' }}>T</div>
      <div style={{ position: 'absolute', right: -6, top: '64%', fontSize: 9, fontWeight: 700, color: 'var(--fl-fail)' }}>F</div>
      <Handle id="true" type="source" position={Position.Right} className="fl-handle" style={{ top: '38%', borderColor: 'var(--fl-ok)' }} />
      <Handle id="false" type="source" position={Position.Right} className="fl-handle" style={{ top: '68%', borderColor: 'var(--fl-fail)' }} />
    </div>
  )
}
