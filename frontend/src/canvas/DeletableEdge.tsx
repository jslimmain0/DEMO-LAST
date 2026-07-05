import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useEditorStore } from '../store/editorStore'

// 선 중앙에 × 버튼이 떠서 클릭으로 연결을 삭제. (Delete 키로도 삭제 가능)
export function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected }: EdgeProps) {
  const removeEdge = useEditorStore((s) => s.removeEdge)
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })

  return (
    <>
      {/* 실행 경과 표시(FlowCanvas)가 넘긴 strokeWidth 는 존중 — 지나간/진행 중 경로가 굵게 보인다 */}
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ ...style, strokeWidth: selected ? 2.5 : (style?.strokeWidth ?? 1.5) }} />
      <EdgeLabelRenderer>
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
