import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { PendingInputRequest } from '../api/types'
import { Modal } from './Modal'

/**
 * input(사용자 입력) 노드 모달 — 실행이 이 노드에서 멈추면 뜬다.
 * 값을 입력하고 확인(Enter)하면 그 값이 노드 출력이 되어 다음 노드에서 바인딩된다.
 * 필드 타입(string/number/boolean/json)대로 confirm 시점에 파싱한다 — json 이면 객체/배열도 그대로 전달.
 * Esc/취소는 실행 중단.
 */
export function InputPromptDialog({
  input,
  onConfirm,
  onCancel,
}: {
  input: PendingInputRequest
  onConfirm: (values: Record<string, unknown>) => void
  onCancel: () => void
}) {
  // 필드 미정의 노드도 최소 한 칸은 받게 한다
  const fields = input.fields.length > 0 ? input.fields : [{ key: 'value', label: '값', type: 'string' }]
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.type === 'boolean' ? 'false' : ''])),
  )
  const [error, setError] = useState<string | null>(null)

  const confirm = () => {
    const out: Record<string, unknown> = {}
    for (const f of fields) {
      const raw = values[f.key] ?? ''
      const t = f.type ?? 'string'
      const name = f.label || f.key
      if (t === 'number') {
        const n = Number(raw)
        if (raw.trim() === '' || !Number.isFinite(n)) {
          setError(`"${name}" 값은 숫자여야 합니다.`)
          return
        }
        out[f.key] = n
      } else if (t === 'boolean') {
        out[f.key] = raw === 'true'
      } else if (t === 'json') {
        try {
          out[f.key] = raw.trim() === '' ? null : JSON.parse(raw)
        } catch {
          setError(`"${name}" 값이 유효한 JSON 이 아닙니다.`)
          return
        }
      } else {
        out[f.key] = raw
      }
    }
    onConfirm(out)
  }

  return (
    <Modal onClose={onCancel} ariaLabel="사용자 입력 대기" zIndex={220} closeOnBackdrop={false} width={420} maxWidth="100%" maxHeight="76vh"
      onKeyDown={(e) => { if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); confirm() } }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
          <span aria-hidden style={{ color: 'var(--fl-cat-input)', fontSize: 15 }}>⌨</span>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>입력 대기 · {input.nodeName || input.nodeId}</strong>
        </header>
        <div style={{ padding: 16, display: 'grid', gap: 10, overflowY: 'auto' }}>
          {input.message && <p style={{ margin: 0, fontSize: 13.5, color: 'var(--fl-text)', lineHeight: 1.5 }}>{input.message}</p>}
          {fields.map((f, i) => {
            const t = f.type ?? 'string'
            return (
              <div key={f.key}>
                <label style={label} htmlFor={`fl-input-${f.key}`}>
                  {f.label || f.key}
                  {t !== 'string' && <span style={{ marginLeft: 6, fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, opacity: 0.7 }}>{t}</span>}
                </label>
                {t === 'json' ? (
                  <textarea
                    id={`fl-input-${f.key}`}
                    autoFocus={i === 0}
                    style={{ ...field, fontFamily: 'var(--fl-font-mono)', minHeight: 90, resize: 'vertical' }}
                    value={values[f.key] ?? ''}
                    onChange={(e) => { setError(null); setValues((v) => ({ ...v, [f.key]: e.target.value })) }}
                    placeholder={'{ "key": "value" }'}
                  />
                ) : t === 'boolean' ? (
                  <select
                    id={`fl-input-${f.key}`}
                    autoFocus={i === 0}
                    style={field}
                    value={values[f.key] ?? 'false'}
                    onChange={(e) => { setError(null); setValues((v) => ({ ...v, [f.key]: e.target.value })) }}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    id={`fl-input-${f.key}`}
                    autoFocus={i === 0}
                    style={{ ...field, fontFamily: t === 'number' ? 'var(--fl-font-mono)' : undefined }}
                    inputMode={t === 'number' ? 'decimal' : undefined}
                    value={values[f.key] ?? ''}
                    onChange={(e) => { setError(null); setValues((v) => ({ ...v, [f.key]: e.target.value })) }}
                  />
                )}
              </div>
            )
          })}
          {error && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--fl-fail)' }}>⚠ {error}</p>}
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--fl-text-muted)' }}>확인(Enter)하면 이 값이 노드 출력이 되어 다음 노드에서 바인딩됩니다. 취소(Esc)는 실행을 중단합니다.</p>
        </div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--fl-border)' }}>
          <button onClick={onCancel} style={ghostBtn}>취소</button>
          <button onClick={confirm} style={primaryBtn}>확인</button>
        </footer>
    </Modal>
  )
}

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', marginBottom: 5 }
const field: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13 }
const ghostBtn: CSSProperties = { padding: '8px 14px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
const primaryBtn: CSSProperties = { ...ghostBtn, border: 'none', background: 'var(--fl-primary)', color: '#fff' }
