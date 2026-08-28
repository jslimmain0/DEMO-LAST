import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import type { NodeType } from '../api/types'
import { PALETTE } from './nodeFactory'
import { catColor, typeIcon } from './nodeMeta'

/**
 * 위치 지정 노드 추가 메뉴 — 캔버스 우클릭/더블클릭·엣지 드래그를 빈 곳에 놓았을 때 뜬다.
 * 검색 가능한 팔레트 목록에서 고르면 onPick(type). 화면 밖으로 안 넘치게 위치 보정.
 */
export function NodeAddMenu({ x, y, onPick, onClose, title }: {
  x: number; y: number; onPick: (type: NodeType) => void; onClose: () => void; title?: string
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const items = useMemo(() => {
    const query = q.trim().toLowerCase()
    return PALETTE.filter((p) => !query || p.label.toLowerCase().includes(query) || p.type.includes(query))
  }, [q])
  const left = Math.min(x, window.innerWidth - 240)
  const top = Math.min(y, window.innerHeight - 340)
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div style={{ position: 'fixed', left, top, zIndex: 61, width: 220, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { onClose(); return }
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); return }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return }
            if (e.key === 'Enter' && items[active]) onPick(items[active].type)
          }}
          placeholder={title ?? '노드 추가 — 검색'}
          style={{ width: '100%', padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, outline: 'none' }} />
        <div style={{ maxHeight: 280, overflow: 'auto', padding: 4 }}>
          {items.length === 0 && <div style={{ padding: 10, fontSize: 12, color: 'var(--fl-text-muted)' }}>일치하는 노드가 없습니다.</div>}
          {items.map((p, i) => (
            <button key={p.type} onClick={() => onPick(p.type)} onMouseEnter={() => setActive(i)}
              style={{ ...item, ...(i === active ? { background: 'var(--fl-surface-2)' } : null) }}>
              <span aria-hidden style={{ color: catColor(p.cat), width: 18, textAlign: 'center' }}>{typeIcon(p.type)}</span>
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

const item: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5, borderRadius: 6 }
