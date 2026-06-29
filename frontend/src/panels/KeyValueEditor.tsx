import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { Binding, NodeField } from '../api/types'
import { BindingChip } from '../binding/BindingChip'
import { BindingPicker } from '../binding/BindingPicker'
import type { BindableSource } from '../binding/upstream'
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

const VALUE_TYPES = ['string', 'number', 'boolean', 'json', 'array']

export function KeyValueEditor({
  rows,
  onChange,
  sources,
  showType = false,
}: {
  rows: NodeField[]
  onChange: (rows: NodeField[]) => void
  sources: BindableSource[]
  showType?: boolean // JSON 바디에서만 값 타입(따옴표 여부) 선택 노출
}) {
  const [pickFor, setPickFor] = useState<string | null>(null)
  const update = (id: string, patch: Partial<NodeField>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const add = () => onChange([...rows, { id: newId(), key: '', value: '' }])
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id))
  const sourceType = (b: Binding) => sources.find((s) => s.id === b.sourceId)?.type

  return (
    <div>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={input} value={r.key} placeholder="key" onChange={(e) => update(r.id, { key: e.target.value })} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            {r.bound ? (
              <BindingChip binding={r.bound} sourceType={sourceType(r.bound)} onRemove={() => update(r.id, { bound: null })} onClick={() => setPickFor(r.id)} />
            ) : (
              <>
                <input style={input} value={r.value ?? ''} placeholder="value 또는 { } 로 삽입" onChange={(e) => update(r.id, { value: e.target.value })} />
                <button onClick={() => setPickFor(r.id)} title="데이터 삽입" aria-label="데이터 삽입" style={braceBtn}>{'{ }'}</button>
              </>
            )}
          </div>
          {showType && (
            <select
              style={typeSel}
              title="JSON 값 타입(따옴표 여부)"
              aria-label="값 타입"
              value={r.type ?? 'string'}
              onChange={(e) => update(r.id, { type: e.target.value })}
            >
              {VALUE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <button onClick={() => remove(r.id)} aria-label="행 삭제" style={delBtn}>×</button>
          {pickFor === r.id && (
            <BindingPicker sources={sources} onClose={() => setPickFor(null)} onPick={(b) => update(r.id, { bound: b, value: '' })} />
          )}
        </div>
      ))}
      <button onClick={add} style={addBtn}>+ 추가</button>
    </div>
  )
}

const braceBtn: CSSProperties = { width: 32, height: 32, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', fontFamily: 'var(--fl-font-mono)', fontSize: 12 }
const delBtn: CSSProperties = { width: 30, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const typeSel: CSSProperties = { flexShrink: 0, width: 78, padding: '6px 4px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 11.5 }
const addBtn: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
