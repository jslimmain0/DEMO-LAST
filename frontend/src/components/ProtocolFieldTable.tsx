// frontend/src/components/ProtocolFieldTable.tsx — 고정길이 필드 표(이름/길이/타입/패딩/오프셋/필드 플러그인) + 파라미터 폼.
// 오프셋은 baseOffset 부터 누적(읽기전용) — 헤더 표는 0, 본문 표는 tableLen(header) 부터.
import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { CodecInfo, FieldPad, FieldType, ProtocolField, TransformParam } from '../api/types'
import { FIELD_PADS, FIELD_TYPES, defaultPad, padOf } from '../lib/protocolSpec'

/** 플러그인/코덱 파라미터 폼 — type 별 input/number/select. */
export function ParamsForm({ params, config, onChange, readOnly }: {
  params: TransformParam[]
  config?: Record<string, string>
  onChange: (config: Record<string, string>) => void
  readOnly: boolean
}) {
  return (
    <>
      {params.map((p) => {
        const val = config?.[p.key] ?? p.defaultValue
        const set = (v: string) => onChange({ ...config, [p.key]: v })
        return (
          <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>{p.label}</span>
            {p.type === 'select' && (p.options?.length ?? 0) > 0 ? (
              <select value={val} disabled={readOnly} onChange={(e) => set(e.target.value)} style={{ ...sel, minWidth: 100 }}>
                {p.options!.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input type={p.type === 'number' ? 'number' : 'text'} value={val} disabled={readOnly} placeholder={p.placeholder}
                onChange={(e) => set(e.target.value)} style={{ ...input, width: p.type === 'number' ? 90 : 150 }} />
            )}
          </label>
        )
      })}
    </>
  )
}

export function FieldTable({ fields, onChange, baseOffset, codecs, readOnly, lengthField, reservedNames }: {
  fields: ProtocolField[]
  onChange: (fields: ProtocolField[]) => void
  baseOffset: number
  codecs: CodecInfo[]
  readOnly: boolean
  /** 프레이밍 길이 필드 이름(해당 행에 표시만) */
  lengthField?: string
  /** 같은 전문에서 이미 쓰는 이름(본문 표에는 헤더 이름) — 백엔드가 헤더+본문 값을 한 맵으로 합치므로 겹치면 안 된다 */
  reservedNames?: string[]
}) {
  // pad 를 손댄 행은 type 을 바꿔도 pad 를 유지한다(그 외에는 defaultPad 로 따라감)
  const [padTouched, setPadTouched] = useState<Set<number>>(() => new Set())
  const [pluginRow, setPluginRow] = useState<number | null>(null)
  const fieldCodecs = codecs.filter((c) => c.layer === 'field')

  const seen = new Map<string, number>()
  for (const f of fields) seen.set(f.name, (seen.get(f.name) ?? 0) + 1)
  const reserved = new Set(reservedNames ?? [])

  const patch = (i: number, p: Partial<ProtocolField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)))
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= fields.length) return
    const next = [...fields]
    ;[next[i], next[j]] = [next[j], next[i]]
    setPadTouched(new Set())
    setPluginRow(null)
    onChange(next)
  }
  const remove = (i: number) => { setPadTouched(new Set()); setPluginRow(null); onChange(fields.filter((_, j) => j !== i)) }
  const add = (type: FieldType, len: number, pad: FieldPad) => onChange([...fields, { name: `필드${fields.length + 1}`, len, type, pad }])

  let off = baseOffset
  const offsets = fields.map((f) => { const o = off; off += Number(f.len) || 0; return o })

  return (
    <div>
      <div style={grid}>
        {['', '이름', '길이', '타입', '패딩', '위치', '◈', ''].map((h, i) => (
          <div key={i} style={th}>{h}</div>
        ))}
        {fields.map((f, i) => {
          const isLen = f.type === 'length'
          const clash = reserved.has(f.name)
          const dupe = (seen.get(f.name) ?? 0) > 1 || clash
          const rowBg = isLen ? { background: 'color-mix(in srgb, var(--fl-primary) 7%, transparent)' } : null
          return (
            <div key={i} style={{ display: 'contents' }}>
              <div style={{ ...td, ...rowBg, display: 'flex', gap: 2 }}>
                <button aria-label="위로" title="위로" disabled={readOnly || i === 0} onClick={() => move(i, -1)} style={arrowBtn}>▲</button>
                <button aria-label="아래로" title="아래로" disabled={readOnly || i === fields.length - 1} onClick={() => move(i, 1)} style={arrowBtn}>▼</button>
              </div>
              <div style={{ ...td, ...rowBg }}>
                <input aria-label={`필드 ${i + 1} 이름`} value={f.name} disabled={readOnly} onChange={(e) => patch(i, { name: e.target.value })}
                  title={clash ? '헤더와 이름이 겹칩니다' : dupe ? '이름이 중복됩니다 — 바인딩이 섞입니다' : f.name === lengthField ? '프레이밍 길이 필드' : undefined}
                  style={{ ...input, width: '100%', ...(dupe ? { borderColor: 'var(--fl-fail)' } : null) }} />
              </div>
              <div style={{ ...td, ...rowBg }}>
                <input aria-label={`필드 ${i + 1} 길이`} type="number" min={1} value={f.len} disabled={readOnly}
                  onChange={(e) => patch(i, { len: Number(e.target.value) || 0 })} style={{ ...input, width: '100%', fontFamily: 'var(--fl-font-mono)' }} />
              </div>
              <div style={{ ...td, ...rowBg }}>
                <select aria-label={`필드 ${i + 1} 타입`} value={f.type} disabled={readOnly}
                  onChange={(e) => {
                    const t = e.target.value as FieldType
                    patch(i, padTouched.has(i) ? { type: t } : { type: t, pad: defaultPad(t) })
                  }} style={{ ...sel, width: '100%' }}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ ...td, ...rowBg }}>
                <select aria-label={`필드 ${i + 1} 패딩`} value={padOf(f)} disabled={readOnly}
                  onChange={(e) => { setPadTouched(new Set(padTouched).add(i)); patch(i, { pad: e.target.value as FieldPad }) }} style={{ ...sel, width: '100%' }}>
                  {FIELD_PADS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={{ ...td, ...rowBg, fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, color: 'var(--fl-text-muted)', display: 'flex', gap: 5, alignItems: 'center' }}>
                <span>@{offsets[i]}</span>
                {isLen && <span title="조립할 때 전체 길이로 자동 채워집니다" style={autoChip}>자동</span>}
              </div>
              <div style={{ ...td, ...rowBg }}>
                <button aria-label={`필드 ${i + 1} 플러그인`} title={f.plugin ? `플러그인 ${f.plugin.id}` : '필드 플러그인(암호화·인코딩)'}
                  onClick={() => setPluginRow(pluginRow === i ? null : i)}
                  style={{ ...arrowBtn, width: 26, color: f.plugin ? 'var(--fl-primary)' : 'var(--fl-text-muted)', fontWeight: f.plugin ? 700 : 400 }}>◈</button>
              </div>
              <div style={{ ...td, ...rowBg }}>
                <button aria-label={`필드 ${i + 1} 삭제`} title="삭제" disabled={readOnly} onClick={() => remove(i)} style={{ ...arrowBtn, width: 24 }}>×</button>
              </div>
              {pluginRow === i && (
                <div style={pluginPanel}>
                  <select aria-label="필드 플러그인" value={f.plugin?.id ?? ''} disabled={readOnly}
                    onChange={(e) => patch(i, { plugin: e.target.value ? { id: e.target.value, config: {} } : null })} style={{ ...sel, minWidth: 180 }}>
                    <option value="">(없음)</option>
                    {fieldCodecs.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                  {f.plugin && (
                    <ParamsForm params={fieldCodecs.find((c) => c.id === f.plugin!.id)?.params ?? []} config={f.plugin.config} readOnly={readOnly}
                      onChange={(config) => patch(i, { plugin: { id: f.plugin!.id, config } })} />
                  )}
                  <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>len 은 <b>변환 후</b> 길이입니다.</span>
                  {f.plugin && !readOnly && <button onClick={() => patch(i, { plugin: null })} style={miniBtn}>제거</button>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {!fields.length && <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', padding: '10px 2px' }}>필드가 없습니다.</div>}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => add('string', 10, 'right/space')} style={miniBtn}>+ 문자 필드</button>
          <button onClick={() => add('numeric', 8, 'left/zero')} style={miniBtn}>+ 숫자 필드</button>
        </div>
      )}
    </div>
  )
}

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: '48px minmax(120px,1fr) 78px 104px 118px 88px 32px 30px', gap: 4, alignItems: 'center' }
const th: CSSProperties = { fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', padding: '0 2px 2px' }
const td: CSSProperties = { padding: '2px', borderRadius: 4, minWidth: 0 }
const input: CSSProperties = { padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const sel: CSSProperties = { padding: '5px 6px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const arrowBtn: CSSProperties = { width: 21, height: 24, padding: 0, border: '1px solid var(--fl-border)', borderRadius: 4, background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', fontSize: 10, cursor: 'pointer' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const autoChip: CSSProperties = { fontSize: 10, padding: '0 4px', borderRadius: 4, background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)' }
const pluginPanel: CSSProperties = { gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '2px 0 6px', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
