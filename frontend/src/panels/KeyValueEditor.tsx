import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Binding, NodeField } from '../api/types'
import { BindingChip } from '../binding/BindingChip'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { duplicateKeys, parseDotEnv } from '../lib/bulkPaste'
import { Modal } from '../components/Modal'
import { bindingToToken, isTokenizable } from '../lib/tokenGrammar'
import { newId } from '../lib/ids'
import './field-layout.css'

const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '8px 10px', // PropertyPanel field 와 같은 리듬 — 행마다 높이가 들쭉날쭉하지 않게
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontFamily: 'var(--fl-font-mono)',
  fontSize: 12.5,
}

const VALUE_TYPES = ['string', 'number', 'boolean', 'json', 'array']

export function KeyValueEditor({
  rows,
  onChange,
  sources,
  showType = false,
  warnDupes = true,
}: {
  rows: NodeField[]
  onChange: (rows: NodeField[]) => void
  sources: BindableSource[]
  showType?: boolean // JSON 바디에서만 값 타입(따옴표 여부) 선택 노출
  warnDupes?: boolean // 중복 키 경고 — 중복이 유효한 곳(쿼리 params a=1&a=2)은 끈다
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [pasting, setPasting] = useState(false)
  const [paste, setPaste] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const focusRow = useRef<string | null>(null)
  const update = (id: string, patch: Partial<NodeField>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const add = () => {
    const id = newId(); focusRow.current = id; setQuery(''); setFilter('all')
    onChange([...rows, { id, key: '', value: '' }])
  }
  useEffect(() => {
    const element = Array.from(box.current?.querySelectorAll<HTMLInputElement>('[data-field-key]') ?? []).find(el => el.dataset.fieldKey === focusRow.current)
    if (element) { element.focus(); element.scrollIntoView({ block: 'nearest' }); focusRow.current = null }
  }, [rows.length, query, filter])
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id))
  const dup = (id: string) => {
    const idx = rows.findIndex((r) => r.id === id)
    if (idx < 0) return
    onChange([...rows.slice(0, idx + 1), { ...rows[idx], id: newId() }, ...rows.slice(idx + 1)])
  }
  const sourceType = (b: Binding) => sources.find((s) => s.id === b.sourceId)?.type
  const dupSet = warnDupes ? duplicateKeys(rows.map((r) => r.key)) : new Set<string>()
  const text = query.trim().toLocaleLowerCase()
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) =>
    (!text || `${r.key} ${r.value ?? ''} ${r.bound ? bindingToToken(r.bound) : ''}`.toLocaleLowerCase().includes(text)) &&
    (filter === 'all' || (filter === 'duplicates' ? dupSet.has(r.key.trim()) : !r.bound && !r.value)))
  const parsed = parseDotEnv(paste)

  return (
    <div ref={box} className="fl-field-editor">
      {(rows.length > 5 || query || filter !== 'all') && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <input type="search" aria-label="필드 키 또는 값 검색" value={query} onChange={e => setQuery(e.target.value)} placeholder="키 또는 값 검색" style={{ ...input, flex: '1 1 140px' }} />
        <select aria-label="필드 상태 필터" value={filter} onChange={e => setFilter(e.target.value)} style={typeSel}>
          <option value="all">전체</option><option value="empty">빈 값</option>{warnDupes && <option value="duplicates">중복 키</option>}
        </select>
        <span role="status" style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{shown.length}/{rows.length}개</span>
      </div>}
      <div style={{ maxHeight: 'min(520px, 55vh)', overflowY: 'auto', padding: 2 }}>
      {shown.length === 0 && rows.length > 0 && <p style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>일치하는 필드가 없습니다. <button style={addBtn} onClick={() => { setQuery(''); setFilter('all') }}>필터 초기화</button></p>}
      {shown.map(({ r, i }) => (
        <div key={r.id} className="fl-field-entry">
          <div className="fl-field-identity">
          <input
            style={{ ...input, ...(r.key.trim() && dupSet.has(r.key.trim()) ? dupWarn : null) }}
            value={r.key} placeholder="키" aria-label={`${i + 1}번째 필드 키`} data-field-key={r.id}
            title={r.key.trim() && dupSet.has(r.key.trim()) ? '중복 키 — 같은 키가 여러 행에 있습니다' : undefined}
            onChange={(e) => update(r.id, { key: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && i === rows.length - 1) { e.preventDefault(); add() } }}
          />
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
          </div>
          <div className="fl-field-value">
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
          <div className="fl-field-actions">
            <button onClick={() => dup(r.id)} aria-label={`${r.key || i + 1} 행 복제`} title="이 행 복제" style={delBtn}>복제</button>
            <button onClick={() => remove(r.id)} aria-label={`${r.key || i + 1} 행 삭제`} style={delBtn}>삭제</button>
          </div>
        </div>
      ))}
      </div>
      <div className="fl-field-footer"><button onClick={add} style={addBtn}>+ 추가</button>
      <button onClick={() => setPasting(true)} style={addBtn}>여러 필드 붙여넣기</button></div>
      {pasting && <Modal onClose={() => { setPasting(false); setPaste('') }} ariaLabel="여러 필드 붙여넣기" width={640} card={{ padding: 18, gap: 12 }}>
        <b>여러 필드 붙여넣기</b>
        <p style={{ fontSize: 12, color: 'var(--fl-text-muted)', margin: 0 }}>한 줄에 KEY=value 또는 Key: value로 입력하세요. 기존 행 뒤에 추가됩니다.</p>
        <textarea autoFocus aria-label="붙여넣을 필드" value={paste} onChange={e => setPaste(e.target.value)} rows={10} style={input} placeholder={'Content-Type: application/json\nAuthorization: Bearer {{ token@secret }}'} />
        <span role="status" style={{ fontSize: 12 }}>{parsed.length}개 필드 추가 예정</span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={() => { setPasting(false); setPaste('') }} style={addBtn}>취소</button>
          <button disabled={!parsed.length} onClick={() => {
            onChange([...rows, ...parsed.map(p => ({ ...p, id: newId() }))]); setQuery(''); setFilter('all'); setPaste(''); setPasting(false)
          }} style={addBtn}>필드 {parsed.length}개 추가</button>
        </div>
      </Modal>}
    </div>
  )
}

const delBtn: CSSProperties = { padding: '3px 8px', minHeight: 28, flexShrink: 0, border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
const dupWarn: CSSProperties = { borderColor: 'var(--fl-put)', boxShadow: '0 0 0 1px var(--fl-put) inset' }
const typeSel: CSSProperties = { flexShrink: 0, width: 78, padding: '6px 4px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 11.5 }
const addBtn: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
