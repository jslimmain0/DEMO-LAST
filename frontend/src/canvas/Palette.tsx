import { useReactFlow } from '@xyflow/react'
import type { CSSProperties, DragEvent } from 'react'
import type { GraphNode, HttpMethod, NodeType } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { useEditorStore } from '../store/editorStore'
import { PALETTE } from './nodeFactory'
import { catColor, typeIcon } from './nodeMeta'

export function Palette({ width = 200 }: { width?: number }) {
  const addNode = useEditorStore((s) => s.addNode)
  const addNodeFromTemplate = useEditorStore((s) => s.addNodeFromTemplate)
  const palette = useEditorStore((s) => s.palette)
  const removePaletteGroup = useEditorStore((s) => s.removePaletteGroup)
  const removePaletteItem = useEditorStore((s) => s.removePaletteItem)
  const { screenToFlowPosition } = useReactFlow()

  const center = () => screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })

  const onDragStart = (e: DragEvent<HTMLButtonElement>, type: NodeType) => {
    e.dataTransfer.setData('application/flowlink-node', type)
    e.dataTransfer.effectAllowed = 'copy'
  }
  const onDragStartTemplate = (e: DragEvent<HTMLDivElement>, node: GraphNode) => {
    e.dataTransfer.setData('application/flowlink-template', JSON.stringify(node))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside
      aria-label="노드 팔레트"
      style={{
        width,
        flexShrink: 0,
        background: 'var(--fl-surface)',
        padding: 'var(--fl-sp-3)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        overflowY: 'auto',
      }}
    >
      <div style={groupTitle}>노드</div>
      {PALETTE.map((p) => (
        <button
          key={p.type}
          draggable
          onDragStart={(e) => onDragStart(e, p.type)}
          onClick={() => addNode(p.type, center())}
          title={`${p.label} 추가 (클릭 또는 드래그)`}
          style={paletteBtn}
        >
          <span aria-hidden style={{ color: catColor(p.cat), fontSize: 15, width: 18, textAlign: 'center' }}>
            {typeIcon(p.type)}
          </span>
          {p.label}
        </button>
      ))}

      {palette.map((group) => (
        <section key={group.id} aria-label={`가져온 API: ${group.title}`} style={{ marginTop: 8 }}>
          <div style={{ ...groupTitle, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={group.title}>
              {group.title}
            </span>
            <button onClick={() => removePaletteGroup(group.id)} aria-label="그룹 제거" title="그룹 제거" style={xBtn}>×</button>
          </div>
          {group.items.map((item) => (
            <div
              key={item.id}
              draggable
              onDragStart={(e) => onDragStartTemplate(e, item.node)}
              onClick={() => addNodeFromTemplate(item.node, center())}
              title={`${item.label} 추가 (클릭 또는 드래그)`}
              style={templateRow}
            >
              <MethodTag method={(item.method ?? 'GET') as HttpMethod} />
              <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.label}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removePaletteItem(group.id, item.id)
                }}
                aria-label="항목 제거"
                title="항목 제거"
                style={xBtn}
              >
                ×
              </button>
            </div>
          ))}
        </section>
      ))}

      <p style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 'auto', lineHeight: 1.5 }}>
        클릭 또는 Enter로 중앙에 추가, 캔버스로 드래그도 가능합니다.
      </p>
    </aside>
  )
}

const groupTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--fl-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  padding: '4px 6px 8px',
}
const paletteBtn: CSSProperties = {
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
}
const templateRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '7px 8px',
  marginBottom: 4,
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface-2)',
  cursor: 'grab',
  color: 'var(--fl-text)',
}
const xBtn: CSSProperties = {
  width: 20,
  height: 20,
  flexShrink: 0,
  border: 'none',
  borderRadius: 5,
  background: 'transparent',
  color: 'var(--fl-text-muted)',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
}
