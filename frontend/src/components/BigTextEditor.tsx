import type { CSSProperties } from 'react'
import { Modal } from './Modal'

/**
 * 거의 전체화면 텍스트 편집 모달 — HTML 응답 템플릿·콜백 본문·raw 바디처럼
 * 작은 textarea 로 쓰기 힘든 긴 본문을 크게 편집한다. value/onChange 를 그대로 물려받아
 * 원본 입력과 실시간 동기화(닫으면 그 상태가 남는다 — 별도 저장 없음).
 */
export function BigTextEditor({
  title,
  value,
  onChange,
  onClose,
  placeholder,
  hint,
}: {
  title: string
  value: string
  onChange: (v: string) => void
  onClose: () => void
  placeholder?: string
  hint?: string
}) {
  return (
    <Modal onClose={onClose} ariaLabel={title} width="min(1500px, 96vw)" maxWidth="96vw" height="92vh" maxHeight="94vh" zIndex={320} card={{ padding: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--fl-border)', flexShrink: 0 }}>
        <strong style={{ flex: 1, fontFamily: 'var(--fl-font-head)', fontSize: 14.5 }}>{title}</strong>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{value.length.toLocaleString()}자</span>
        <button onClick={onClose} aria-label="닫기" title="닫기 (Esc)" style={xBtn}>×</button>
      </header>
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          flex: 1, minHeight: 0, width: '100%', boxSizing: 'border-box', resize: 'none',
          padding: '14px 16px', border: 'none', outline: 'none',
          background: 'var(--fl-surface)', color: 'var(--fl-text)',
          fontFamily: 'var(--fl-font-mono)', fontSize: 13, lineHeight: 1.65, tabSize: 2,
        }}
      />
      {hint && <p style={{ margin: 0, padding: '8px 16px', borderTop: '1px solid var(--fl-border)', fontSize: 11.5, color: 'var(--fl-text-muted)', flexShrink: 0 }}>{hint}</p>}
    </Modal>
  )
}

/** 작은 textarea 우상단에 붙이는 ⤢(크게 편집) 버튼 — 부모는 position:relative 컨테이너로 감싼다. */
export function ExpandCorner({ onClick, label = '크게 편집' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={`${label} — 거의 전체화면`}
      style={corner}
    >⤢</button>
  )
}

const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15, flexShrink: 0 }
const corner: CSSProperties = {
  position: 'absolute', top: 5, right: 7, width: 24, height: 24,
  border: '1px solid var(--fl-border)', borderRadius: 6,
  background: 'var(--fl-surface)', color: 'var(--fl-text-muted)',
  cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  opacity: 0.85,
}
