import { useEffect, useState, type CSSProperties } from 'react'

/** 미니 토스트 — 어디서든 toast('메시지', 'error') 호출, <Toasts/>는 App 에 1회 마운트. */

export type ToastKind = 'info' | 'error' | 'ok'

interface ToastItem {
  id: number
  msg: string
  kind: ToastKind
}

let seq = 0
let listener: ((items: ToastItem[]) => void) | null = null
let items: ToastItem[] = []

function emit() {
  listener?.([...items])
}

export function toast(msg: string, kind: ToastKind = 'info') {
  const id = ++seq
  items = [...items, { id, msg, kind }]
  emit()
  window.setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500)
}

function dismiss(id: number) {
  if (!items.some((t) => t.id === id)) return
  items = items.filter((t) => t.id !== id)
  emit()
}

export function Toasts() {
  const [list, setList] = useState<ToastItem[]>([])
  useEffect(() => {
    listener = setList
    return () => {
      if (listener === setList) listener = null
    }
  }, [])
  if (list.length === 0) return null
  return (
    <div style={wrap} role="status" aria-live="polite">
      {list.map((t) => (
        <button key={t.id} style={{ ...card, ...byKind[t.kind] }} onClick={() => dismiss(t.id)} title="닫기">
          {t.msg}
        </button>
      ))}
    </div>
  )
}

const wrap: CSSProperties = {
  position: 'fixed',
  bottom: 20,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  zIndex: 300,
  maxWidth: 'min(520px, calc(100vw - 40px))',
}

const card: CSSProperties = {
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  boxShadow: 'var(--fl-shadow-lg)',
  padding: '10px 14px',
  font: '13px/1.5 var(--fl-font-ui)',
  textAlign: 'left',
  cursor: 'pointer',
}

const byKind: Record<ToastKind, CSSProperties> = {
  info: {},
  ok: { borderColor: 'var(--fl-ok)' },
  error: { borderColor: 'var(--fl-fail)' },
}
