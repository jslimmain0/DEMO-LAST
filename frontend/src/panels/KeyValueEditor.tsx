import type { CSSProperties } from 'react'
import type { Binding, NodeField } from '../api/types'
import { BindingChip } from '../binding/BindingChip'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { bindingToToken, isTokenizable } from '../lib/tokenGrammar'
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
  const update = (id: string, patch: Partial<NodeField>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const add = () => onChange([...rows, { id: newId(), key: '', value: '' }])
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id))
  const sourceType = (b: Binding) => sources.find((s) => s.id === b.sourceId)?.type

  return (
    <div>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={input} value={r.key} placeholder="key" onChange={(e) => update(r.id, { key: e.target.value })} />
          <div style={{ flex: 1.4, minWidth: 0, display: 'flex' }}>
            {/* 값은 텍스트+토큰 칩 혼합 입력 — 구(舊) bound 저장분은 토큰으로 표시되고, 수정하는 순간 토큰 문자열로 이관된다.
                토큰 문법이 못 담는 키/id 의 bound 는 이관하면 조용히 깨지므로 구조적 바인딩 칩을 유지한다. */}
            {r.bound && !isTokenizable(r.bound) ? (
              <BindingChip binding={r.bound} sourceType={sourceType(r.bound)} onRemove={() => update(r.id, { bound: null })} />
            ) : (
              <TokenInput
                ariaLabel={`값 ${r.key || ''}`}
                value={r.bound ? bindingToToken(r.bound) : (r.value ?? '')}
                onChange={(v) => update(r.id, { value: v, bound: null })}
                sources={sources}
                placeholder="value 또는 { } 로 삽입"
              />
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
        </div>
      ))}
      <button onClick={add} style={addBtn}>+ 추가</button>
    </div>
  )
}

const delBtn: CSSProperties = { width: 30, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const typeSel: CSSProperties = { flexShrink: 0, width: 78, padding: '6px 4px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 11.5 }
const addBtn: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
