import { useReactFlow } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from './graphAdapter'
import { annoColor } from './nodeMeta'

const GRID = 22
const snap = (v: number) => Math.round(v / GRID) * GRID
const MIN_W = GRID * 5
const MIN_H = GRID * 3

/**
 * 영역 박스 — 노드들 '뒤'에 깔리는 표시용 사각형(실행 제외).
 * 본체는 pointer-events 를 통과시켜(css .react-flow__node-annogroup) 안의 노드/캔버스 조작을
 * 방해하지 않고, 제목바(드래그 이동·선택)와 우하단 핸들(크기 조절)만 잡힌다.
 */
export function GroupNode({ data, selected }: NodeProps) {
  const n = asGraphNode(data)
  const update = useEditorStore((s) => s.updateNodeData)
  const { getZoom } = useReactFlow()
  const w = n.groupW ?? 396
  const h = n.groupH ?? 264
  const c = annoColor(n.noteColor, 'gray')

  // 우하단 핸들 드래그로 크기 조절 — 포인터 캡처(창 밖/캔버스 위에서도 안전 종료), 줌 보정, 그리드 스냅
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const zoom = getZoom() || 1
    const sx = e.clientX
    const sy = e.clientY
    const w0 = w
    const h0 = h
    let lw = w0 // 마지막 반영값 — 스냅 단위가 안 바뀌면 store 업데이트 생략
    let lh = h0
    const onMove = (ev: PointerEvent) => {
      const nw = Math.max(MIN_W, snap(w0 + (ev.clientX - sx) / zoom))
      const nh = Math.max(MIN_H, snap(h0 + (ev.clientY - sy) / zoom))
      if (nw !== lw || nh !== lh) {
        lw = nw
        lh = nh
        update(n.id, { groupW: nw, groupH: nh })
      }
    }
    const done = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', done)
      el.removeEventListener('pointercancel', done)
      try {
        el.releasePointerCapture(ev.pointerId)
      } catch {
        /* 이미 해제됨 */
      }
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', done)
    el.addEventListener('pointercancel', done)
  }

  return (
    <div
      style={{
        width: w,
        height: h,
        background: c.bg,
        border: `1.5px dashed ${selected ? 'var(--fl-primary)' : c.border}`,
        borderRadius: 10,
        position: 'relative',
        fontFamily: 'var(--fl-font-ui)',
      }}
    >
      <div
        className="fl-group-drag fl-group-bar"
        title="드래그해 이동 · 클릭해 선택"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          cursor: 'grab',
          borderRadius: '10px 10px 0 0',
        }}
      >
        <span aria-hidden style={{ color: c.border, fontSize: 11 }}>▢</span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: c.border, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {n.name || '영역'}
        </span>
      </div>
      <div
        className="fl-group-resize nodrag nopan"
        role="separator"
        aria-label="영역 크기 조절"
        title="드래그해 크기 조절"
        onPointerDown={onResizeStart}
        style={{
          position: 'absolute',
          right: 1,
          bottom: 1,
          width: 18,
          height: 18,
          cursor: 'nwse-resize',
          borderRight: `3px solid ${c.border}`,
          borderBottom: `3px solid ${c.border}`,
          borderBottomRightRadius: 8,
          opacity: 0.8,
        }}
      />
    </div>
  )
}
