import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Binding } from '../api/types'
import { catColor, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { useEscapeClose } from '../components/useEscapeClose'
import type { BindableItem, BindableSource } from './upstream'

// 상위 노드들의 요청/응답 규격을 블록으로 골라 바인딩을 삽입하는 모달 (UI/UX 스펙 §7.3).
export function BindingPicker({
  sources,
  onPick,
  onClose,
}: {
  sources: BindableSource[]
  onPick: (binding: Binding) => void
  onClose: () => void
}) {
  useEscapeClose(onClose)
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase()
    if (!query) return sources
    return sources
      .map((s) => ({ ...s, items: s.items.filter((it) => it.key.toLowerCase().includes(query)) }))
      .filter((s) => s.items.length > 0 || s.name.toLowerCase().includes(query))
  }, [sources, q])

  const pick = (s: BindableSource, it: BindableItem) => {
    onPick({ nodeName: s.name, cat: s.cat, key: it.key, sourceId: s.id, scope: it.scope })
    onClose()
  }

  // 키보드 선택 — 검색 후 방향키로 이동, Enter 로 삽입
  const flat = useMemo(() => filtered.flatMap((s) => s.items.map((it) => ({ s, it }))), [filtered])
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [q])
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const sel = flat[active]; if (sel) pick(sel.s, sel.it) }
  }
  let gi = -1

  return (
    <div role="dialog" aria-modal="true" aria-label="데이터 삽입" style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>데이터 삽입</strong>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="키 검색… (↑↓ 이동, Enter 삽입)" style={search} />
          <button onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        <div style={{ overflowY: 'auto', padding: 8, flex: 1 }}>
          {filtered.length === 0 && (
            <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, padding: 16, textAlign: 'center' }}>
              연결된 상위 노드가 없습니다. 먼저 이 노드에 이전 노드를 연결하세요.
            </p>
          )}
          {filtered.map((s) => (
            <section key={s.id} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', fontSize: 12, fontWeight: 700, color: 'var(--fl-text-muted)' }}>
                <span aria-hidden style={{ color: catColor(s.cat) }}>{typeIcon(s.type)}</span>
                {s.name}
                <span style={{ fontWeight: 400, fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, opacity: 0.7 }}>{typeLabel(s.type)} · #{s.id}</span>
              </div>
              {/* 파라미터는 세로 목록 대신 블럭(칩)으로 나열 — 한눈에 훑고 바로 집는다 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 8px 4px 27px' }}>
                {s.items.map((it, i) => {
                  gi++
                  const isActive = gi === active
                  return (
                  <button
                    key={`${it.group}-${it.key}-${i}`}
                    onClick={() => pick(s, it)}
                    onMouseEnter={() => setActive(gi)}
                    className="fl-bind-chip"
                    title={`${it.group === 'response' ? '응답' : '요청'} · ${it.key}${it.type ? ` (${it.type})` : ''}`}
                    style={{ ...chipBtn(it.group === 'response'), ...(isActive ? { outline: '2px solid var(--fl-primary)', outlineOffset: 1 } : {}) }}
                  >
                    {/* 색 단독 금지(1.4.1) — 응답/요청 구분은 텍스트 태그로 */}
                    <span style={{ fontSize: 9.5, fontWeight: 700, flexShrink: 0, color: it.group === 'response' ? 'var(--fl-ok)' : 'var(--fl-running)' }}>
                      {it.group === 'response' ? '응답' : '요청'}
                    </span>
                    <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>{it.key}</span>
                    {it.type && <span style={typeBadge}>{it.type}</span>}
                  </button>
                ) })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.34)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 520, maxWidth: '100%', maxHeight: '70vh', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const search: CSSProperties = { flex: 1, padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13 }
function chipBtn(isResponse: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    border: `1px solid color-mix(in srgb, ${isResponse ? 'var(--fl-ok)' : 'var(--fl-running)'} 45%, var(--fl-border))`,
    borderRadius: 'var(--fl-radius-pill)',
    background: 'var(--fl-surface)',
    cursor: 'pointer',
    color: 'var(--fl-text)',
    maxWidth: '100%',
  }
}
const typeBadge: CSSProperties = { fontSize: 10, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 5, flexShrink: 0 }
