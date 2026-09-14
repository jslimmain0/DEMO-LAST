import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ParseWarning, TextForm } from '../lib/textForms'

/**
 * [필드 | 텍스트] 공용 토글 — 어떤 필드 표든 TextForm 하나로 텍스트 보기를 얻는다.
 * 전환할 때마다 실제 변환(toText/fromText). 텍스트 편집은 300ms 디바운스로 필드에 반영되고, 실패 줄은 경고로 남는다(텍스트는 보존).
 */
export function FieldTextToggle<T>({ form, rows, onChange, children, title, extras, readOnly, mode: modeProp, onModeChange, summary, ariaLabel }: {
  form: TextForm<T>; rows: T[]; onChange: (rows: T[]) => void
  children: ReactNode; title?: ReactNode; extras?: ReactNode; readOnly?: boolean
  mode?: 'fields' | 'text'; onModeChange?: (m: 'fields' | 'text') => void
  summary?: (rows: T[]) => ReactNode; ariaLabel?: string
}) {
  const [modeState, setModeState] = useState<'fields' | 'text'>('fields')
  const mode = modeProp ?? modeState
  const setMode = (m: 'fields' | 'text') => { onModeChange?.(m); if (modeProp === undefined) setModeState(m) }
  const [buf, setBuf] = useState('')
  const [warnings, setWarnings] = useState<ParseWarning[]>([])
  const lastEmitted = useRef<T[] | null>(null)
  const timer = useRef<number | null>(null)

  // 텍스트 모드 진입/외부 변경 시 버퍼 재생성(내가 emit 한 rows 면 건너뜀 — 커서 점프 방지)
  useEffect(() => {
    if (mode !== 'text') return
    if (lastEmitted.current === rows) return
    setBuf(form.toText(rows)); setWarnings([])
  }, [mode, rows, form])

  const apply = (text: string) => {
    const r = form.fromText(text, rows)
    setWarnings(r.warnings)
    lastEmitted.current = r.rows
    onChange(r.rows)
  }
  const onText = (text: string) => {
    setBuf(text)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => apply(text), 300)
  }
  const toFields = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    apply(buf)
    setMode('fields')
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  return (
    <div>
      <div style={head}>
        {title !== undefined && <span style={{ minWidth: 0 }}>{title}</span>}
        <div style={seg} role="group" aria-label={ariaLabel ? `${ariaLabel} 보기` : '보기 전환'}>
          <button type="button" onClick={toFields} style={segBtn(mode === 'fields')} aria-pressed={mode === 'fields'}>필드</button>
          <button type="button" onClick={() => setMode('text')} style={segBtn(mode === 'text')} aria-pressed={mode === 'text'} title={form.label}>텍스트</button>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{extras}</div>
      </div>
      {mode === 'fields' ? children : (
        <div>
          <textarea
            aria-label={ariaLabel ? `${ariaLabel} 텍스트` : '텍스트'}
            value={buf} readOnly={readOnly} spellCheck={false}
            placeholder={form.placeholder}
            onChange={(e) => onText(e.target.value)}
            style={ta}
            rows={Math.max(4, Math.min(16, buf.split('\n').length + 1))}
          />
          <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>{form.label} · 300ms 뒤 필드에 반영</span>
            {summary && <span>{summary(rows)}</span>}
          </div>
          {warnings.length > 0 && (
            <ul style={warnList} role="alert">
              {warnings.map((w, i) => <li key={i}><b>{w.line}행</b> {w.reason} — <code style={{ opacity: .8 }}>{w.text.slice(0, 60)}</code></li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }
const seg: CSSProperties = { display: 'inline-flex', gap: 2, background: 'var(--fl-surface-2)', borderRadius: 7, padding: 2, flexShrink: 0 }
function segBtn(active: boolean): CSSProperties {
  return { padding: '4px 10px', border: 'none', borderRadius: 5, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--fl-surface)' : 'transparent', color: active ? 'var(--fl-primary)' : 'var(--fl-text-muted)', boxShadow: active ? 'var(--fl-shadow)' : 'none' }
}
const ta: CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--fl-font-mono)', fontSize: 12, lineHeight: 1.5, padding: '8px 10px', resize: 'vertical', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)' }
const warnList: CSSProperties = { margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }
