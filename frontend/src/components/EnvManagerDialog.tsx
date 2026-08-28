import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { duplicateKeys, parseDotEnv } from '../lib/bulkPaste'
import { getEnvStore, setEnvStore, useEnvStore } from '../lib/environments'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 환경(dev/staging/prod) 관리 다이얼로그.
 * 환경마다 변수 묶음(키-값)을 두고, 활성 환경을 고르면 실행 시 그 변수들이 `{{ key@env }}` 로 주입된다.
 * baseUrl·토큰·계정 같은 값을 노드마다 안 고치고 환경 전환 한 번으로 바꾸는 용도.
 * 저장은 브라우저 localStorage(개인 스코프) — 즐겨찾기/클립보드와 같은 패턴.
 */
export function EnvManagerDialog({ onClose }: { onClose: () => void }) {
  const store = useEnvStore()
  const names = useMemo(() => Object.keys(store.envs).sort((a, b) => a.localeCompare(b)), [store.envs])
  const [selected, setSelected] = useState<string | null>(store.active ?? names[0] ?? null)
  // 선택 환경이 삭제되면 유효한 것으로 보정
  useEffect(() => {
    if (selected && !store.envs[selected]) setSelected(store.active ?? Object.keys(store.envs)[0] ?? null)
  }, [store.envs, store.active, selected])

  const addEnv = () => {
    const base = '환경'
    let name = base
    let n = 1
    const s = getEnvStore()
    while (s.envs[name]) name = `${base}-${++n}`
    setEnvStore({ active: s.active ?? name, envs: { ...s.envs, [name]: {} } })
    setSelected(name)
  }
  const renameEnv = (from: string, to: string) => {
    const t = to.trim()
    const s = getEnvStore()
    if (!t || t === from || s.envs[t]) return
    const envs: Record<string, Record<string, string>> = {}
    for (const [k, v] of Object.entries(s.envs)) envs[k === from ? t : k] = v
    setEnvStore({ active: s.active === from ? t : s.active, envs })
    setSelected(t)
  }
  const duplicateEnv = (name: string) => {
    const s = getEnvStore()
    const src = s.envs[name]
    if (!src) return
    let copy = `${name}-복사`
    let n = 1
    while (s.envs[copy]) copy = `${name}-복사-${++n}`
    setEnvStore({ ...s, envs: { ...s.envs, [copy]: { ...src } } })
    setSelected(copy)
  }
  const deleteEnv = (name: string) => {
    const s = getEnvStore()
    const { [name]: _drop, ...rest } = s.envs
    void _drop
    setEnvStore({ active: s.active === name ? null : s.active, envs: rest })
    setSelected(Object.keys(rest)[0] ?? null)
  }
  const setActive = (name: string | null) => {
    const s = getEnvStore()
    setEnvStore({ ...s, active: name && s.envs[name] ? name : null })
  }
  const setVars = (name: string, vars: Record<string, string>) => {
    const s = getEnvStore()
    setEnvStore({ ...s, envs: { ...s.envs, [name]: vars } })
  }

  const vars = selected ? store.envs[selected] ?? {} : {}

  return (
    <Modal onClose={onClose} ariaLabel="환경 관리" width={720} card={{ padding: 18 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span aria-hidden style={{ fontSize: 15 }}>🌐</span>
          <b style={{ flex: 1, fontSize: 15 }}>환경 관리</b>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>
        <p style={hint}>
          환경마다 변수(baseUrl·토큰 등)를 두고 <b>활성 환경</b>을 고르면 실행 시 <code style={code}>{'{{ 키@env }}'}</code> 로 주입됩니다.
          노드를 일일이 안 고치고 dev/staging/prod 를 한 번에 전환하세요.
        </p>

        {names.length === 0 ? (
          <div style={empty}>
            아직 환경이 없습니다.
            <button onClick={addEnv} style={{ ...primaryBtn, marginLeft: 10 }}>+ 환경 만들기</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 14, marginTop: 10, minHeight: 0 }}>
            {/* 환경 목록 */}
            <div style={{ width: 190, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {names.map((name) => (
                <div
                  key={name}
                  style={{ ...envRow, ...(selected === name ? envRowSel : null) }}
                  onClick={() => setSelected(name)}
                >
                  <input
                    type="radio"
                    name="active-env"
                    checked={store.active === name}
                    onChange={() => setActive(name)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`${name} 활성화`}
                    title="활성 환경으로 설정"
                    style={{ cursor: 'pointer' }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }} title={name}>{name}</span>
                  <span style={countBadge}>{Object.keys(store.envs[name]).length}</span>
                </div>
              ))}
              <button onClick={addEnv} style={addBtn}>+ 환경</button>
            </div>

            {/* 선택 환경 변수 편집 */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              {selected ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <input
                      key={selected}
                      defaultValue={selected}
                      aria-label="환경 이름"
                      style={{ ...mono, flex: 1, fontFamily: 'var(--fl-font-ui)' }}
                      onBlur={(e) => renameEnv(selected, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                    <button onClick={() => duplicateEnv(selected)} style={ghostBtn} title="이 환경을 변수째 복제 (dev 를 복사해 staging 만들기)">⧉ 복제</button>
                    <button onClick={() => deleteEnv(selected)} style={ghostBtn} title="이 환경 삭제">삭제</button>
                  </div>
                  {/* key={selected} — 환경을 바꿀 때만 새 초기값으로 리마운트. 같은 환경 편집 중엔
                      로컬 rows 가 source of truth 라 작성 중(빈 키) 행이 store 갱신에 덮여 사라지지 않는다. */}
                  <VarEditor key={selected} initial={vars} onChange={(v) => setVars(selected, v)} />
                  {store.active === selected
                    ? <p style={{ ...hint, color: 'var(--fl-ok)' }}>✓ 활성 환경 — 실행 시 이 변수들이 주입됩니다.</p>
                    : <p style={hint}>이 환경을 쓰려면 왼쪽 라디오로 <b>활성화</b>하세요.</p>}
                </>
              ) : (
                <div style={empty}>왼쪽에서 환경을 선택하세요.</div>
              )}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={primaryBtn} onClick={onClose}>닫기</button>
        </div>
    </Modal>
  )
}

/**
 * 환경 변수 행 편집기 — 순수 문자열 키/값(토큰·바인딩 없음). rows 가 편집 중 source of truth.
 * initial 은 마운트 시점 초기값으로만 쓰고 이후 prop 변화를 재반영하지 않는다(부모가 key={환경}로 리마운트).
 * → 빈 키(작성 중) 행이 자신의 onChange 로 인한 store 갱신에 덮여 사라지는 유실 버그 방지.
 */
function VarEditor({ initial, onChange }: { initial: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  // 삽입 순서 보존을 위해 배열로 편집 후 맵으로 직렬화
  const [rows, setRows] = useState<Array<{ k: string; v: string }>>(() => Object.entries(initial).map(([k, v]) => ({ k, v })))
  const [filter, setFilter] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null) // rows 반영 후 포커스할 input 의 data-var 값

  const commit = (next: Array<{ k: string; v: string }>) => {
    setRows(next)
    const out: Record<string, string> = {}
    for (const { k, v } of next) if (k.trim()) out[k.trim()] = v
    onChange(out)
  }
  const setRow = (i: number, patch: Partial<{ k: string; v: string }>) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => { setFilter(''); pendingFocus.current = `k${rows.length}`; commit([...rows, { k: '', v: '' }]) }
  const delRow = (i: number) => commit(rows.filter((_, j) => j !== i))
  useEffect(() => {
    if (!pendingFocus.current) return
    const el = boxRef.current?.querySelector<HTMLInputElement>(`[data-var="${pendingFocus.current}"]`)
    pendingFocus.current = null
    el?.focus()
  }, [rows.length])

  // .env 붙여넣기 일괄 추가 — 같은 키는 값 갱신, 새 키는 뒤에 추가
  const applyPaste = () => {
    const parsed = parseDotEnv(pasteText)
    if (!parsed.length) { toast('KEY=value 형식의 줄을 찾지 못했습니다.', 'error'); return }
    const next = [...rows]
    let added = 0, updated = 0
    for (const { key, value } of parsed) {
      const idx = next.findIndex((r) => r.k.trim() === key)
      if (idx >= 0) { if (next[idx].v !== value) { next[idx] = { ...next[idx], v: value }; updated++ } }
      else { next.push({ k: key, v: value }); added++ }
    }
    commit(next)
    setPasteText(''); setPasteOpen(false); setFilter('')
    toast(`변수 ${added}개 추가${updated ? ` · ${updated}개 갱신` : ''}`, 'ok')
  }

  const dup = duplicateKeys(rows.map((r) => r.k))
  const f = filter.trim().toLowerCase()
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !f || r.k.toLowerCase().includes(f) || r.v.toLowerCase().includes(f))

  return (
    <div ref={boxRef} style={{ overflowY: 'auto', maxHeight: 300 }}>
      {rows.length === 0 && <p style={{ ...hint, marginTop: 2 }}>변수를 추가하세요 (예: <code style={code}>baseUrl</code> = <code style={code}>https://dev.api.example.com</code>).</p>}
      {rows.length >= 8 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`변수 검색… (${rows.length}개)`} aria-label="변수 검색"
          style={{ ...mono, width: '100%', marginBottom: 6, fontFamily: 'var(--fl-font-ui)', boxSizing: 'border-box' }} />
      )}
      {f && visible.length === 0 && <p style={{ ...hint, marginTop: 2 }}>검색과 일치하는 변수가 없습니다.</p>}
      {visible.map(({ r, i }) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            style={{ ...mono, flex: 1, fontFamily: 'var(--fl-font-mono)', ...(r.k.trim() && dup.has(r.k.trim()) ? dupWarn : null) }}
            value={r.k} placeholder="키" data-var={`k${i}`}
            title={r.k.trim() && dup.has(r.k.trim()) ? '중복 키 — 마지막 값이 적용됩니다' : undefined}
            onChange={(e) => setRow(i, { k: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); boxRef.current?.querySelector<HTMLInputElement>(`[data-var="v${i}"]`)?.focus() } }}
          />
          <input
            style={{ ...mono, flex: 1.4, fontFamily: 'var(--fl-font-mono)' }} value={r.v} placeholder="값" data-var={`v${i}`}
            onChange={(e) => setRow(i, { v: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              // Enter = 다음 행으로, 마지막 행이면 새 행 추가 — 여러 변수를 손 안 떼고 입력
              if (i === rows.length - 1) addRow()
              else boxRef.current?.querySelector<HTMLInputElement>(`[data-var="k${i + 1}"]`)?.focus()
            }}
          />
          <button onClick={() => delRow(i)} aria-label="변수 삭제" style={delBtn}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={addRow} style={addBtn}>+ 변수</button>
        <button onClick={() => setPasteOpen((v) => !v)} style={addBtn} title="KEY=value 여러 줄(.env 형식)을 한 번에 붙여넣어 추가">📋 .env 붙여넣기</button>
      </div>
      {pasteOpen && (
        <div style={{ marginTop: 6 }}>
          <textarea
            value={pasteText} onChange={(e) => setPasteText(e.target.value)} autoFocus
            placeholder={'baseUrl=https://dev.api.example.com\ntoken=abc123\n# 주석·빈 줄은 무시'}
            aria-label=".env 붙여넣기"
            style={{ ...mono, width: '100%', minHeight: 84, fontFamily: 'var(--fl-font-mono)', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button onClick={applyPaste} style={{ ...primaryBtn, padding: '6px 12px', fontSize: 12 }}>추가</button>
            <button onClick={() => { setPasteOpen(false); setPasteText('') }} style={ghostBtn}>취소</button>
            <span style={{ ...hint, alignSelf: 'center', marginTop: 0 }}>같은 키는 값이 갱신됩니다.</span>
          </div>
        </div>
      )}
    </div>
  )
}

const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const mono: CSSProperties = { padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, minWidth: 0 }
const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const ghostBtn: CSSProperties = { padding: '7px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
const addBtn: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
const delBtn: CSSProperties = { width: 30, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer' }
const envRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', cursor: 'pointer' }
const envRowSel: CSSProperties = { borderColor: 'var(--fl-primary)', background: 'var(--fl-surface-2)' }
const dupWarn: CSSProperties = { borderColor: 'var(--fl-put)', boxShadow: '0 0 0 1px var(--fl-put) inset' }
const countBadge: CSSProperties = { flexShrink: 0, fontSize: 10.5, color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderRadius: 8, padding: '1px 6px' }
const empty: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fl-text-muted)', fontSize: 12.5, padding: 24 }
