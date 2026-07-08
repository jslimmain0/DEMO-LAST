import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useEffect } from 'react'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { catColor, typeIcon } from './nodeMeta'
import { RunBadge } from './NodeCard'

// 스위치 기본 트랙 — switchPorts 없이 저장된(손편집) 그래프 방어
const DEFAULT_PORTS = [{ id: '1', label: '1' }, { id: '2', label: '2' }]

/**
 * 경로 스위치(선로 전환기) — 조건 없이 사용자가 젖혀둔 트랙으로만 실행이 흐른다.
 * 트랙 행을 클릭하면 레버가 그 트랙으로 젖혀진다(switchActive). 엣지 fromPort=트랙 id.
 */
export function SwitchNode({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const update = useEditorStore((s) => s.updateNodeData)
  const runState = useEditorStore((s) => s.runView?.nodeStates[n.id])
  const running = runState === 'running'
  const accent = catColor('switch')
  const ports = n.switchPorts?.length ? n.switchPorts : DEFAULT_PORTS
  const active = n.switchActive ?? ports[0].id
  // 트랙(핸들) 수가 바뀌면 RF 에 핸들 위치 재측정을 알린다 — 엣지 앵커가 옛 위치에 붙는 것 방지
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(n.id)
  }, [ports.length, n.id, updateNodeInternals])
  const borderColor = running
    ? 'var(--fl-running)'
    : runState === 'failed'
      ? 'var(--fl-fail)'
      : selected
        ? accent
        : runState === 'success'
          ? 'var(--fl-ok)'
          : 'var(--fl-border)'

  return (
    <div
      className={running ? 'fl-node-running' : undefined}
      style={{
        width: 230, // NodeCard 와 동일 고정 폭
        background: 'var(--fl-surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--fl-radius)',
        boxShadow: selected ? 'var(--fl-shadow-lg)' : 'var(--fl-shadow)',
        fontFamily: 'var(--fl-font-ui)',
        opacity: runState === 'skipped' ? 0.55 : 1,
      }}
    >
      <Handle type="target" position={Position.Left} className="fl-handle" style={{ borderColor: accent }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderLeft: `3px solid ${accent}` }}>
        <span aria-hidden style={{ color: accent, fontSize: 14, width: 16, textAlign: 'center' }}>{typeIcon('switch')}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name ?? '스위치'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>선로 전환기 — 트랙 클릭</div>
        </div>
        <RunBadge state={runState} />
      </div>

      <div style={{ borderTop: '1px solid var(--fl-border)', padding: '4px 0' }}>
        {ports.map((p) => {
          const on = p.id === active
          return (
            <div
              key={p.id}
              className="nodrag fl-switch-track"
              role="radio"
              aria-checked={on}
              aria-label={`트랙 ${p.label || p.id}`}
              title={on ? '젖혀진 트랙 — 실행이 이 선로로 흐릅니다' : '클릭해 이 트랙으로 전환'}
              onClick={(e) => {
                e.stopPropagation()
                if (!on) update(n.id, { switchActive: p.id })
              }}
              style={{
                position: 'relative',
                height: 26,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '0 14px 0 12px',
                cursor: 'pointer',
              }}
            >
              {/* 선로 — 젖혀진 트랙은 진한 실선, 나머지는 흐린 점선 */}
              <span
                aria-hidden
                style={{
                  flex: 1,
                  borderTop: on ? `2.5px solid ${accent}` : '2px dashed var(--fl-border)',
                  opacity: on ? 1 : 0.9,
                }}
              />
              <span
                style={{
                  flexShrink: 0,
                  maxWidth: 110,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 11,
                  fontWeight: on ? 700 : 500,
                  fontFamily: 'var(--fl-font-mono)',
                  color: on ? accent : 'var(--fl-text-muted)',
                }}
              >
                {on ? '▶ ' : ''}{p.label || p.id}
              </span>
              <Handle
                id={p.id}
                type="source"
                position={Position.Right}
                className="fl-handle"
                style={{ top: '50%', borderColor: on ? accent : 'var(--fl-border)' }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
