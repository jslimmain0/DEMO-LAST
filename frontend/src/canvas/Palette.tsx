import { useReactFlow } from '@xyflow/react'
import type { DragEvent } from 'react'
import type { NodeType } from '../api/types'
import { useEditorStore } from '../store/editorStore'
import { PALETTE } from './nodeFactory'
import { catColor, typeIcon } from './nodeMeta'

export function Palette() {
  const addNode = useEditorStore((s) => s.addNode)
  const { screenToFlowPosition } = useReactFlow()

  const addCenter = (type: NodeType) => {
    const pos = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    addNode(type, pos)
  }
  const onDragStart = (e: DragEvent<HTMLButtonElement>, type: NodeType) => {
    e.dataTransfer.setData('application/flowlink-node', type)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside
      aria-label="노드 팔레트"
      style={{
        width: 200,
        borderRight: '1px solid var(--fl-border)',
        background: 'var(--fl-surface)',
        padding: 'var(--fl-sp-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        overflowY: 'auto',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', textTransform: 'uppercase', letterSpacing: '.06em', padding: '4px 6px 8px' }}>
        노드
      </div>
      {PALETTE.map((p) => (
        <button
          key={p.type}
          draggable
          onDragStart={(e) => onDragStart(e, p.type)}
          onClick={() => addCenter(p.type)}
          title={`${p.label} 추가 (클릭 또는 드래그)`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            border: '1px solid var(--fl-border)',
            borderRadius: 'var(--fl-radius-sm)',
            background: 'var(--fl-surface)',
            cursor: 'grab',
            fontSize: 13.5,
            fontWeight: 500,
            color: 'var(--fl-text)',
            textAlign: 'left',
          }}
        >
          <span aria-hidden style={{ color: catColor(p.cat), fontSize: 15, width: 18, textAlign: 'center' }}>
            {typeIcon(p.type)}
          </span>
          {p.label}
        </button>
      ))}
      <p style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 'auto', lineHeight: 1.5 }}>
        클릭 또는 Enter로 중앙에 추가, 캔버스로 드래그도 가능합니다.
      </p>
    </aside>
  )
}
