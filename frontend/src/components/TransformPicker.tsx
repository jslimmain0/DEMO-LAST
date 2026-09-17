import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TransformInfo } from '../api/types'

/** 이름순(한글 로케일) 정렬 — 플러그인 목록이 길어져도 찾기 쉽게. */
export function sortTransforms(list: TransformInfo[]): TransformInfo[] {
  return [...list].sort((a, b) => a.label.localeCompare(b.label, 'ko') || a.id.localeCompare(b.id))
}

/** 검색 — 이름/id/설명 아무 곳이나(대소문자 무시, 공백으로 나눈 단어 AND). */
export function filterTransforms(list: TransformInfo[], q: string): TransformInfo[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter((t) => {
    const hay = `${t.label} ${t.id} ${t.description ?? ''}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/**
 * 변환 플러그인 선택기 — 검색 + 이름순 정렬 드롭다운(네이티브 select 대체).
 * TRANSFORM 노드·Mock 코덱 단계 공용. 현재 값이 목록에 없으면(플러그인 제거 등) "(없음)" 으로 표시.
 */
export function TransformPicker({ list, value, onChange, disabled, placeholder = '플러그인 선택…', style, onCreateNew }: {
  list: TransformInfo[]
  value: string
  onChange: (id: string) => void
  disabled?: boolean
  placeholder?: string
  style?: CSSProperties
  onCreateNew?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sorted = useMemo(() => sortTransforms(list), [list])
  const shown = useMemo(() => filterTransforms(sorted, q), [sorted, q])
  const current = list.find((t) => t.id === value)

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 0) } }, [open])
  useEffect(() => { setActive(0) }, [q])
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    // Esc 는 문서 캡처 단계에서 — 포커스가 아직 버튼에 있어도 닫히고, 바깥 모달(useEscapeClose)까지 닫히지 않게 전파 차단
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (id: string) => { onChange(id); setOpen(false) }

  return (
    <div ref={rootRef} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? `${current.label} (${current.id})${current.description ? ' — ' + current.description : ''}` : placeholder}
        style={{ ...btn, color: current ? 'var(--fl-text)' : 'var(--fl-text-muted)', opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>
          {current ? <>{current.label} <span style={{ color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{current.id}</span></>
            : value ? <>{value} <span style={{ color: 'var(--fl-fail)' }}>(없음)</span></> : placeholder}
        </span>
        <span aria-hidden style={{ fontSize: 10, color: 'var(--fl-text-muted)' }}>▾</span>
      </button>
      {open && (
        <div role="listbox" style={pop} onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); const t = shown[active]; if (t) pick(t.id) }
        }}>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`검색 — 이름·id·설명 (${list.length}개)`}
            aria-label="플러그인 검색"
            style={search}
          />
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {shown.length === 0 && <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--fl-text-muted)' }}>일치하는 플러그인이 없습니다.</div>}
            {shown.map((t, i) => (
              <div
                key={t.id}
                role="option"
                aria-selected={t.id === value}
                data-idx={i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(t.id) }}
                style={{ ...item, background: i === active ? 'var(--fl-surface-2)' : 'transparent', fontWeight: t.id === value ? 700 : 500 }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.id === value ? '✓ ' : ''}{t.label}</span>
                  <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{t.id}</span>
                </div>
                {t.description && <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</div>}
              </div>
            ))}
          </div>
          {onCreateNew && (
            <button type="button" onMouseDown={(e) => { e.preventDefault(); setOpen(false); onCreateNew() }}
              style={{ width: '100%', padding: '8px 12px', border: 'none', borderTop: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-primary)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
              ＋ 새 플러그인 만들기 → (JS 로 작성, 승인 후 여기 나타남)
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const btn: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 180, padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', fontSize: 12.5, fontFamily: 'var(--fl-font-ui)', textAlign: 'left' }
const pop: CSSProperties = { position: 'absolute', zIndex: 50, top: 'calc(100% + 4px)', left: 0, minWidth: '100%', width: 'max(100%, 360px)', maxWidth: '90vw', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow-lg, 0 8px 24px rgba(0,0,0,.18))', overflow: 'hidden' }
const search: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 12px', border: 'none', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, outline: 'none' }
const item: CSSProperties = { padding: '7px 12px', fontSize: 12.5, cursor: 'pointer', color: 'var(--fl-text)', borderBottom: '1px solid color-mix(in srgb, var(--fl-border) 40%, transparent)' }
