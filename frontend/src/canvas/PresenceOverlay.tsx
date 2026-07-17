import { ViewportPortal } from '@xyflow/react'
import { readableText } from '../lib/contrast'
import { usePresenceStore } from '../store/presenceStore'
import { useEditorStore } from '../store/editorStore'

/**
 * 원격 참여자 표시 — flow 좌표계에 그리는 ViewportPortal(팬/줌 자동 추종).
 * 커서(화살표+이름표)와 편집중 링(노드 테두리+✎ 배지). 전부 pointer-events 없음(캔버스 조작 방해 금지).
 */
export function PresenceOverlay() {
  const peers = usePresenceStore((s) => s.peers)
  const nodes = useEditorStore((s) => s.nodes)
  const list = Object.values(peers)
  if (list.length === 0) return null
  return (
    <ViewportPortal>
      {list.map((p) => {
        if (!p.editing) return null
        const n = nodes.find((nd) => nd.id === p.editing)
        if (!n) return null
        const w = (n.measured?.width ?? 230) + 12
        const h = (n.measured?.height ?? 80) + 12
        return (
          <div key={`ring-${p.id}`} style={{
            position: 'absolute', transform: `translate(${n.position.x - 6}px, ${n.position.y - 6}px)`,
            width: w, height: h, border: `2px solid ${p.color}`, borderRadius: 14,
            pointerEvents: 'none', zIndex: 5,
          }}>
            <span style={{
              position: 'absolute', top: -22, left: 0, background: p.color, color: readableText(p.color),
              fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
            }}>✎ {p.name}</span>
          </div>
        )
      })}
      {list.map((p) => p.cursor && (
        <div key={`cur-${p.id}`} style={{
          position: 'absolute', transform: `translate(${p.cursor.x}px, ${p.cursor.y}px)`,
          pointerEvents: 'none', zIndex: 6, transition: 'transform 80ms linear',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" style={{ display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.4))' }}>
            {/* 외곽선을 굵게(테마 대비 halo) + 그림자 — 라이트/다크 어디서든 또렷하게 */}
            <path d="M4 2 L20 12 L12 13.5 L9 21 Z" fill={p.color} stroke="var(--fl-cursor-halo)" strokeWidth="2.5" strokeLinejoin="round" />
          </svg>
          <span style={{
            marginLeft: 10, background: p.color, color: readableText(p.color), fontSize: 11, fontWeight: 600,
            padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
          }}>{p.name}</span>
        </div>
      ))}
    </ViewportPortal>
  )
}
