import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useEditorStore } from '../store/editorStore'

// 선 중앙에 × 버튼이 떠서 클릭으로 연결을 삭제. (Delete 키로도 삭제 가능)
// 분기(IF: T/F)·스위치(트랙) 엣지는 소스 끝에 포트 칩을 띄워 어느 갈래인지 표시 + 클릭으로 갈래 전환.
export function DeletableEdge({ id, source, target, sourceHandleId, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected }: EdgeProps) {
  const removeEdge = useEditorStore((s) => s.removeEdge)
  const updateEdge = useEditorStore((s) => s.updateEdge)
  const sourceNode = useEditorStore((s) => s.nodes.find((n) => n.id === source))
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  const srcType = (sourceNode?.data as { type?: string } | undefined)?.type
  const handle = sourceHandleId ?? 'out'
  const switchPorts = (sourceNode?.data as { switchPorts?: { id: string; label?: string }[] } | undefined)?.switchPorts ?? []
  let portLabel: string | null = null
  let portColor = 'var(--fl-text-muted)'
  let cycle: (() => void) | null = null
  if (srcType === 'if' && (handle === 'true' || handle === 'false')) {
    portLabel = handle === 'true' ? 'T' : 'F'
    portColor = handle === 'true' ? 'var(--fl-ok)' : 'var(--fl-fail)'
    cycle = () => updateEdge(id, { source, target, sourceHandle: handle === 'true' ? 'false' : 'true', targetHandle: null })
  } else if (srcType === 'switch' && switchPorts.length > 0) {
    const p = switchPorts.find((x) => x.id === handle)
    portLabel = String(p?.label || handle)
    portColor = 'var(--fl-put)'
    cycle = () => {
      const i = switchPorts.findIndex((x) => x.id === handle)
      const next = switchPorts[(i + 1) % switchPorts.length]
      updateEdge(id, { source, target, sourceHandle: next.id, targetHandle: null })
    }
  }

  return (
    <>
      {/* 실행 경과 표시(FlowCanvas)가 넘긴 strokeWidth 는 존중 — 지나간/진행 중 경로가 굵게 보인다 */}
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ ...style, strokeWidth: selected ? 2.5 : (style?.strokeWidth ?? 1.5) }} />
      <EdgeLabelRenderer>
        {portLabel && cycle && (
          <button
            className="nodrag nopan"
            onClick={(e) => { e.stopPropagation(); cycle!() }}
            title={srcType === 'if' ? '분기 전환 (T↔F)' : '트랙 전환(클릭)'}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${sourceX + 16}px, ${sourceY}px)`,
              pointerEvents: 'all',
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 'var(--fl-radius-pill)',
              border: `1px solid ${portColor}`,
              background: 'var(--fl-surface)',
              color: portColor,
              cursor: 'pointer',
              fontSize: 10.5,
              fontWeight: 700,
              lineHeight: '16px',
              boxShadow: 'var(--fl-shadow)',
              fontFamily: 'var(--fl-font-mono)',
            }}
          >
            {portLabel}
          </button>
        )}
        <button
          className="nodrag nopan"
          onClick={(e) => {
            e.stopPropagation()
            removeEdge(id)
          }}
          aria-label="연결 삭제"
          title="연결 삭제"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: '1px solid var(--fl-border)',
            background: 'var(--fl-surface)',
            color: 'var(--fl-fail)',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: '16px',
            padding: 0,
            boxShadow: 'var(--fl-shadow)',
            opacity: selected ? 1 : 0.55,
          }}
        >
          ×
        </button>
      </EdgeLabelRenderer>
    </>
  )
}
