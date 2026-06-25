import type { CSSProperties } from 'react'
import type { NodeField } from '../api/types'
import { newId } from '../lib/ids'

const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '7px 9px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontFamily: 'var(--fl-font-mono)',
  fontSize: 12,
}

export function KeyValueEditor({
  rows,
  onChange,
}: {
  rows: NodeField[]
  onChange: (rows: NodeField[]) => void
}) {
  const update = (id: string, patch: Partial<NodeField>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const add = () => onChange([...rows, { id: newId(), key: '', value: '' }])
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id))

  return (
    <div>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input style={input} value={r.key} placeholder="key" onChange={(e) => update(r.id, { key: e.target.value })} />
          <input style={input} value={r.value ?? ''} placeholder="value 또는 {{ token }}" onChange={(e) => update(r.id, { value: e.target.value })} />
          <button onClick={() => remove(r.id)} aria-label="행 삭제" style={{ width: 30, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={add} style={{ marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }}>
        + 추가
      </button>
    </div>
  )
}
