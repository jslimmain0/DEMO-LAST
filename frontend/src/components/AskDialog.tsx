import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'

/**
 * 앱 스타일의 입력/확인 다이얼로그 — 브라우저 prompt()/confirm() 대체.
 * input 이 있으면 텍스트 입력(prompt), 없으면 확인(confirm). Enter=확인, Esc=취소, 배경 클릭=취소.
 */
export interface AskSpec {
  title: string
  message?: string
  input?: { label?: string; initial?: string; placeholder?: string }
  confirmLabel?: string
  danger?: boolean
  onConfirm: (value: string) => void
}

export function AskDialog({ spec, onClose }: { spec: AskSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.input?.initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (spec.input) { inputRef.current?.focus(); inputRef.current?.select() } }, [spec.input])
  const confirm = () => {
    if (spec.input && !value.trim()) return
    spec.onConfirm(value.trim())
    onClose()
  }
  return (
    <div role="dialog" aria-modal="true" aria-label={spec.title} style={overlay} onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 16, marginBottom: spec.message || spec.input ? 10 : 16 }}>{spec.title}</div>
        {spec.message && <p style={{ margin: '0 0 12px', fontSize: 13.5, color: 'var(--fl-text-muted)', lineHeight: 1.5 }}>{spec.message}</p>}
        {spec.input && (
          <>
            {spec.input.label && <label style={{ display: 'block', fontSize: 12, color: 'var(--fl-text-muted)', marginBottom: 5 }}>{spec.input.label}</label>}
            <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} placeholder={spec.input.placeholder}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirm() } }}
              style={{ width: '100%', padding: '9px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13.5, marginBottom: 16 }} />
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={ghostBtn}>취소</button>
          <button onClick={confirm} style={spec.danger ? dangerBtn : primaryBtn}>{spec.confirmLabel ?? '확인'}</button>
        </div>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 400, maxWidth: '100%', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', padding: 20 }
const ghostBtn: CSSProperties = { padding: '8px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 13, fontWeight: 500 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const dangerBtn: CSSProperties = { ...primaryBtn, background: 'var(--fl-fail)' }
