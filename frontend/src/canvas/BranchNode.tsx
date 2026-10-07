import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { NODE_W } from './nodeMeta'
import { RunBadge } from './NodeCard'
import { NodeAgentBadge } from '../components/AgentSettings'
import { NodeTypeIcon } from '../components/AppIcon'
import './node-visuals.css'

// IF 분기 노드 — true/false 두 source 핸들. fromPort='true'|'false' 라운드트립.
export function BranchNode({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const waitingId = useEditorStore((s) => s.waitingNodeId)
  const runState = useEditorStore((s) => s.runView?.nodeStates[n.id])
  const waiting = waitingId === n.id || runState === 'waiting'
  const running = runState === 'running'
  const borderColor = waiting ? 'var(--fl-waiting)' : running
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
      className={`fl-editor-node${selected ? ' fl-editor-node--selected' : ''}${running ? ' fl-node-running' : ''}`}
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

      <div className="fl-task-header">
        <NodeTypeIcon type="if" size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fl-task-title" title={n.name ?? 'IF 조건'}>{n.name ?? 'IF 조건'}</div>
          <div className="fl-task-subtitle" title={waiting ? '에이전트 작업 대기' : n.condition || '조건 없음'}>
            {waiting ? '에이전트 작업 대기…' : n.condition || '조건 없음'}
          </div>
        </div>
        <RunBadge state={waiting ? 'waiting' : runState} waitingLabel="에이전트 작업 대기" />
      </div>
      <div className="fl-task-footer"><NodeAgentBadge node={n} /></div>

      <div style={{ position: 'absolute', right: -6, top: '34%', fontSize: 9, fontWeight: 700, color: 'var(--fl-ok)' }}>T</div>
      <div style={{ position: 'absolute', right: -6, top: '64%', fontSize: 9, fontWeight: 700, color: 'var(--fl-fail)' }}>F</div>
      <Handle id="true" type="source" position={Position.Right} className="fl-handle" style={{ top: '38%', borderColor: 'var(--fl-ok)' }} />
      <Handle id="false" type="source" position={Position.Right} className="fl-handle" style={{ top: '68%', borderColor: 'var(--fl-fail)' }} />
    </div>
  )
}
