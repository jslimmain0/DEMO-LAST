import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { ParseWarning, TextForm } from '../lib/textForms'

/**
 * [필드 | 텍스트] 공용 토글 — 어떤 필드 표든 TextForm 하나로 텍스트 보기를 얻는다.
 * 전환할 때마다 실제 변환(toText/fromText). 텍스트 편집은 300ms 디바운스로 필드에 반영되고, 실패 줄은 경고로 남는다(텍스트는 보존).
 */
export function FieldTextToggle<T>({ form, rows, onChange, children, title, extras, readOnly, mode: modeProp, onModeChange, summary, ariaLabel }: {
  form: TextForm<T>; rows: T[]
  /** 낸 배열을 참조 그대로 저장할 것 — 복사/정규화하면 텍스트 편집 중 재동기화가 타이핑을 덮는다. */
  onChange: (rows: T[]) => void
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
  /** 지금 버퍼를 만들 때 쓴 텍스트 — 편집 없이 [필드] 로 돌아가는 순수 보기 전환을 알아본다. */
  const genRef = useRef<string | null>(null)
  const timer = useRef<number | null>(null)

  // 텍스트 모드 진입/외부 변경 시 버퍼 재생성(내가 emit 한 rows 면 건너뜀 — 커서 점프 방지)
  // 참조 동일성 비교 — onChange 로 낸 배열을 그대로(복사/정규화 없이) 되받는다는 전제
  useEffect(() => {
    if (mode !== 'text') return
    if (lastEmitted.current === rows) return
    // 참조는 달라도 내용이 같으면(저장 후 재조회·서버 에코·부모의 setState 재생성) 내 버퍼를 지키지 않으면
    // 주석·빈 줄·경고 줄과 커서가 통째로 날아간다(Mock 편집기는 저장마다 spec 을 새 배열로 다시 만든다).
    const text = form.toText(rows)
    if ((lastEmitted.current && text === form.toText(lastEmitted.current)) || (genRef.current !== null && text === genRef.current)) {
      lastEmitted.current = rows
      return
    }
    genRef.current = text
    setBuf(text); setWarnings([])
  }, [mode, rows, form])

  const apply = (text: string) => {
    const r = form.fromText(text, rows)
    setWarnings(r.warnings)
    // 내용이 그대로면 onChange 를 내지 않는다 — 보기만 바꿨는데 '미저장'이 되는 것을 막는다.
    if (form.toText(r.rows) === form.toText(rows)) { lastEmitted.current = rows; return }
    lastEmitted.current = r.rows
    onChange(r.rows)
  }
  const onText = (text: string) => {
    if (readOnly) return
    setBuf(text)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => apply(text), 300)
  }
  const toFields = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    // 텍스트 모드에서 실제로 고친 게 있을 때만 반영(이미 필드 모드거나 생성된 그대로면 no-op)
    if (!readOnly && mode === 'text' && buf !== genRef.current) apply(buf)
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
            <span>{readOnly ? '읽기 전용' : `${form.label} · 300ms 뒤 필드에 반영`}</span>
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
