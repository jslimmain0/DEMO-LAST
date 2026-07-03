import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { PendingInputRequest } from '../api/types'
import { useEscapeClose } from './useEscapeClose'

/**
 * 실행 중 '입력 대기' 노드에서 뜨는 입력 창(프로토타입의 사용자 입력 대기 복원).
 * 안내 문구(waitMsg)와 선언된 필드들을 보여주고, 입력한 값들이 각 키로 노드 출력이 된다.
 */
export function InputPromptDialog({
  input,
  onSubmit,
  onCancel,
}: {
  input: PendingInputRequest
  onSubmit: (values: Record<string, unknown>) => void
  onCancel: () => void // 취소 → 실행은 WAITING 상태로 남김(재실행으로 다시 진입)
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  useEscapeClose(onCancel)

  const submit = () => {
    const out: Record<string, unknown> = {}
    for (const f of input.fields ?? []) out[f.key] = values[f.key] ?? ''
    onSubmit(out)
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="입력 대기" style={overlay}>
      <div style={card}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <span aria-hidden style={{ color: 'var(--fl-cat-wait)', fontSize: 16 }}>✎</span>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>입력 대기 · {input.nodeName || input.nodeId}</strong>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>실행이 일시정지되었습니다</span>
          </div>
          <button onClick={onCancel} aria-label="취소" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        <div style={{ padding: 18, display: 'grid', gap: 12 }}>
          {input.msg && <p style={{ fontSize: 13, color: 'var(--fl-text)', margin: 0, lineHeight: 1.5 }}>{input.msg}</p>}
          {(input.fields ?? []).map((f, i) => (
            <label key={f.key} style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--fl-text-muted)' }}>{f.label || f.key}</span>
              <input
                autoFocus={i === 0}
                placeholder={f.key}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                style={field}
              />
            </label>
          ))}
        </div>

        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--fl-border)' }}>
          <button onClick={onCancel} style={ghost}>취소</button>
          <button onClick={submit} style={primary}>계속</button>
        </footer>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.45)', zIndex: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 420, maxWidth: '100%', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const field: CSSProperties = { padding: '9px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-bg)', color: 'var(--fl-text)', fontSize: 13 }
const primary: CSSProperties = { padding: '9px 18px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const ghost: CSSProperties = { padding: '9px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer' }
