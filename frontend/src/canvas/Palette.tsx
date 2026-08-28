import { useReactFlow } from '@xyflow/react'
import type { CSSProperties, DragEvent } from 'react'
import { useMemo, useState } from 'react'
import type { GraphNode, HttpMethod, NodeType } from '../api/types'
import { MethodTag } from '../components/MethodTag'
import { useEditorStore } from '../store/editorStore'
import { PALETTE, PALETTE_GROUPS } from './nodeFactory'
import { catColor, typeIcon } from './nodeMeta'

export function Palette({ width = 200, onCollapse }: { width?: number; onCollapse?: () => void }) {
  const addNode = useEditorStore((s) => s.addNode)
  const addNodeFromTemplate = useEditorStore((s) => s.addNodeFromTemplate)
  const palette = useEditorStore((s) => s.palette)
  const removePaletteGroup = useEditorStore((s) => s.removePaletteGroup)
  const removePaletteItem = useEditorStore((s) => s.removePaletteItem)
  const { screenToFlowPosition } = useReactFlow()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const shownPalette = useMemo(() => {
    const query = q.trim().toLowerCase()
    return PALETTE.filter((p) => !query || p.label.toLowerCase().includes(query) || p.type.includes(query))
  }, [q])
  const addWithRecent = (type: NodeType) => addNode(type, center())
  const toggleGroup = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={groupTitle}>노드</div>
        {onCollapse && (
          <button onClick={onCollapse} aria-label="팔레트 접기" title="접기"
            style={{ width: 24, height: 24, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13 }}>«</button>
        )}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="노드 검색…"
        style={{ width: '100%', padding: '6px 9px', marginBottom: 4, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, outline: 'none' }} />
      {/* 검색 중엔 평면 목록, 아니면 카테고리 섹션으로(클러터 축소) */}
      {q.trim()
        ? shownPalette.map((p) => (
            <button key={p.type} draggable onDragStart={(e) => onDragStart(e, p.type)} onClick={() => addWithRecent(p.type)} title={`${p.label} 추가 (클릭 또는 드래그)`} style={paletteBtn}>
              <span aria-hidden style={{ color: catColor(p.cat), fontSize: 15, width: 18, textAlign: 'center' }}>{typeIcon(p.type)}</span>{p.label}
            </button>
          ))
        : PALETTE_GROUPS.map((g) => {
            const items = shownPalette.filter((p) => p.group === g)
            if (items.length === 0) return null
            return (
              <div key={g} style={{ marginBottom: 2 }}>
                <div style={{ ...groupTitle, padding: '6px 2px 4px', fontSize: 10, opacity: 0.85 }}>{g}</div>
                {items.map((p) => (
                  <button key={p.type} draggable onDragStart={(e) => onDragStart(e, p.type)} onClick={() => addWithRecent(p.type)} title={`${p.label} 추가 (클릭 또는 드래그)`} style={{ ...paletteBtn, marginBottom: 4 }}>
                    <span aria-hidden style={{ color: catColor(p.cat), fontSize: 15, width: 18, textAlign: 'center' }}>{typeIcon(p.type)}</span>{p.label}
                  </button>
                ))}
              </div>
            )
          })}
      {q.trim() && shownPalette.length === 0 && <div style={{ padding: 8, fontSize: 12, color: 'var(--fl-text-muted)' }}>일치하는 노드 없음</div>}

      {palette.map((group) => {
        const isCollapsed = collapsed.has(group.id)
        return (
        <section key={group.id} aria-label={`가져온 API: ${group.title}`} style={{ marginTop: 8 }}>
          <div style={{ ...groupTitle, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 2px 6px' }}>
            <button
              onClick={() => toggleGroup(group.id)}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? '펼치기' : '접기'}
              style={groupToggle}
            >
              <span aria-hidden style={{ width: 12, flexShrink: 0, fontSize: 10 }}>{isCollapsed ? '▸' : '▾'}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }} title={group.title}>
                {group.title}
              </span>
              <span style={{ flexShrink: 0, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', fontWeight: 500 }}>{group.items.length}</span>
            </button>
            <button onClick={() => removePaletteGroup(group.id)} aria-label="그룹 제거" title="그룹 제거" style={xBtn}>×</button>
          </div>
          {!isCollapsed && group.items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => onDragStartTemplate(e, item.node)}
              onClick={() => addNodeFromTemplate(item.node, center())}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  addNodeFromTemplate(item.node, center())
                }
              }}
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
        )
      })}

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
  // 균일 타일 — 라벨 길이에 따라 버튼 폭이 제각각이 되지 않게 전부 같은 폭·높이로
  width: '100%',
  minHeight: 40,
  padding: '9px 12px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  cursor: 'grab',
  fontSize: 13.5,
  fontWeight: 500,
  color: 'var(--fl-text)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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
const groupToggle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  border: 'none',
  background: 'transparent',
  color: 'var(--fl-text-muted)',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  fontFamily: 'inherit',
  padding: '2px 2px',
}
