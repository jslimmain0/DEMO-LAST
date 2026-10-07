import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { duplicateKeys, parseDotEnv, validateDotEnv } from '../lib/bulkPaste'
import { useEnvStore, useEnvironment, useEnvironmentSaveStatus, useEnvironmentLoadStatus } from '../lib/environments'
import { Modal } from './Modal'
import { useWorkspace } from '../app/WorkspaceContext'
import { AskDialog, type AskSpec } from './AskDialog'
import { toast } from './toast'
import { ResourceScopeNote } from './ResourceScopeNote'
import { useUnsavedNavigation } from './UnsavedNavigation'
import { AppIcon } from './AppIcon'
import { ui } from '../design/ui'

/**
 * 환경(dev/staging/prod) 관리 다이얼로그.
 * 환경마다 변수 묶음(키-값)을 두고, 활성 환경을 고르면 실행 시 그 변수들이 `{{ key@env }}` 로 주입된다.
 * baseUrl·토큰·계정 같은 값을 노드마다 안 고치고 환경 전환 한 번으로 바꾸는 용도.
 * 환경 데이터는 선택한 공간에 저장하고, 활성 환경 이름만 브라우저에 기억한다.
 */
export function EnvManagerDialog({ onClose }: { onClose: () => void }) {
  const [dirty, setDirty] = useState(false)
  const status = useEnvironmentSaveStatus()
  useUnsavedNavigation({ dirty, saving: status === 'pending' || status === 'saving', label: '적용하지 않은 환경 입력', blockedReason: status === 'error' ? '환경 변수를 다시 저장한 뒤 이동하세요. 현재 입력은 유지됩니다.' : undefined })
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const close = () => dirty ? setAsk({ title: '미적용 변경', message: '아직 적용하지 않은 입력을 버리고 닫을까요?', confirmLabel: '버리고 닫기', onConfirm: onClose }) : onClose()
  return <><Modal onClose={close} ariaLabel="환경 관리" width={1060} height="min(780px, 90vh)" card={{ padding: 18 }}><EnvManagerPanel onClose={close} onDraftChange={setDirty} /></Modal>{ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}</>
}

export function EnvManagerPanel({ onClose, onDraftChange, compact = false }: { onClose?: () => void; onDraftChange?: (dirty: boolean) => void; compact?: boolean }) {
  const { current } = useWorkspace()
  const loadStatus = useEnvironmentLoadStatus()
  const readOnly = current.myRole === 'VIEWER'
  const editingBlocked = readOnly || loadStatus !== 'ready'
  const status = useEnvironmentSaveStatus()
  const [draft, setDraft] = useState(false)
  const [ask, setAsk] = useState<AskSpec | null>(null)
  useEffect(() => { onDraftChange?.(draft); return () => onDraftChange?.(false) }, [draft, onDraftChange])
  const leaveDraft = (action: () => void) => {
    if (draft) setAsk({ title: '아직 적용하지 않은 변경', message: '오류가 있는 행 또는 적용하지 않은 텍스트를 버릴까요?', confirmLabel: '버리고 계속', onConfirm: action })
    else action()
  }
 const { getEnvStore, setEnvStore, ensureEnvLoaded, flushEnvStore, renameEnv: renameEnvOnServer } = useEnvironment()

  const store = useEnvStore()
  const names = useMemo(() => Object.keys(store.envs).sort((a, b) => a.localeCompare(b)), [store.envs])
  const [selected, setSelected] = useState<string | null>(store.active ?? names[0] ?? null)
  const [compare, setCompare] = useState('')
  const [envFilter, setEnvFilter] = useState('')
  const shownNames = names.filter(name => name.toLocaleLowerCase().includes(envFilter.trim().toLocaleLowerCase()))
  // 선택 환경이 삭제되면 유효한 것으로 보정
  useEffect(() => {
    if (!selected || !store.envs[selected]) setSelected(store.active ?? Object.keys(store.envs)[0] ?? null)
  }, [store.envs, store.active, selected])

  const addEnv = () => {
    const base = '환경'
    let name = base
    let n = 1
    const s = getEnvStore()
    while (s.envs[name]) name = `${base}-${++n}`
    setEnvStore({ active: s.active ?? name, envs: { ...s.envs, [name]: {} } })
    setSelected(name)
    setEnvFilter('')
  }
  const renameEnv = (from: string, to: string) => {
    const t = to.trim()
    if (!t || t === from || getEnvStore().envs[t]) return
    void renameEnvOnServer(from, t).then(() => { if (getEnvStore().envs[t]) setSelected(t) })
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
  // 다른 환경에는 있는데 이 환경엔 없는 키 — 환경 전환 시 값 누락을 미리 잡는다
  const missingKeys = useMemo(() => {
    if (!selected) return []
    const cur = new Set(Object.keys(store.envs[selected] ?? {}))
    const out = new Set<string>()
    for (const [name, v] of Object.entries(store.envs)) {
      if (name === selected) continue
      for (const k of Object.keys(v)) if (!cur.has(k)) out.add(k)
    }
    return [...out].sort()
  }, [store.envs, selected])

  return (
    <div className="fl-resource-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {!compact && <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <AppIcon name="globe" size={16} />
          <b style={{ flex: 1, fontSize: 16 }}>환경 관리</b>
          {onClose && <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>}
        </header>}
        {!compact && <ResourceScopeNote />}
        {loadStatus === 'loading' && <p role="status" style={hint}>환경 목록을 불러오는 중입니다. 완료 후 편집할 수 있습니다.</p>}
        {loadStatus === 'error' && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>환경 목록을 불러오지 못했습니다. <button style={ghostBtn} onClick={() => void ensureEnvLoaded().catch(() => {})}>다시 불러오기</button></p>}
        {readOnly && <p role="status" style={hint}>읽기 전용 공간입니다. 환경 선택과 비교는 가능하지만 변수는 변경할 수 없습니다.</p>}
        <div role="status" className="fl-env-status"><span>실행에 적용할 환경 <b>{store.active ?? '선택 안 함'}</b></span><span className={`fl-env-save-state fl-env-save-state--${status}`}>{status === 'saved' ? '변수 저장됨' : status === 'pending' ? '저장 대기' : status === 'saving' ? '저장 중…' : '저장 실패'} {status === 'error' && <button style={ghostBtn} onClick={() => void flushEnvStore()}>다시 저장</button>}</span></div>
        {!compact && <p style={hint}>
          환경마다 변수(baseUrl·연결 주소 등)를 두고 <b>활성 환경</b>을 고르면 실행 시 <code style={code}>{'{{ 키@env }}'}</code> 로 주입됩니다.
          노드를 일일이 안 고치고 dev/staging/prod 를 한 번에 전환하세요.
          토큰과 비밀번호는 시크릿 볼트에 저장하세요.
        </p>}

        {names.length === 0 ? (
          <div style={empty}>
            아직 환경이 없습니다.
            <button disabled={editingBlocked} onClick={() => leaveDraft(addEnv)} style={{ ...primaryBtn, marginLeft: 10 }}>+ 환경 만들기</button>
          </div>
        ) : (
          <div className="fl-env-layout">
            {/* 환경 목록 */}
            <div className="fl-env-collection">
              <div className="fl-env-list-heading"><strong>환경 목록</strong><button disabled={editingBlocked} onClick={() => leaveDraft(addEnv)} style={ghostBtn}>+ 환경</button></div>
              <input type="search" aria-label="환경 이름 검색" value={envFilter} onChange={e => setEnvFilter(e.target.value)} placeholder="환경 이름 검색" style={mono} />
              <span style={hint} role="status">환경 {shownNames.length} / {names.length}개</span>
              <div style={{ overflowY: 'auto', minHeight: 0, flex: 1, display: 'grid', alignContent: 'start', gap: 6 }}>
              {shownNames.length === 0 && <p style={hint}>일치하는 환경이 없습니다.</p>}
              {shownNames.map((name) => (
                <div
                  key={name}
                  className="fl-env-entry" data-selected={selected === name}
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
                  <button aria-pressed={selected === name} onClick={() => leaveDraft(() => setSelected(name))} style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', overflow: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'normal', fontSize: 13, padding: '4px 0' }} title={name}>{name}</button>
                  <span style={countBadge}>{Object.keys(store.envs[name]).length}</span>
                </div>
              ))}
              </div>
            </div>

            {/* 선택 환경 변수 편집 */}
            <div className="fl-env-editor">
              {selected ? (
                <>
                  <div className="fl-env-editor-heading">
                    <input
                      key={selected}
                      defaultValue={selected}
                      aria-label="환경 이름"
                      disabled={editingBlocked || draft}
                      style={{ ...mono, flex: 1, fontFamily: 'var(--fl-font-ui)' }}
                      onBlur={(e) => renameEnv(selected, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    />
                    <button disabled={readOnly} onClick={() => leaveDraft(() => duplicateEnv(selected))} style={ghostBtn} title="이 환경을 변수째 복제 (dev 를 복사해 staging 만들기)">⧉ 복제</button>
                    <button disabled={readOnly} onClick={() => setAsk({ title: '환경 삭제', message: selected + ' 환경과 변수 전체를 삭제합니다. 환경별 시크릿은 그대로 남습니다.', danger: true, confirmLabel: '환경 삭제', onConfirm: () => deleteEnv(selected) })} style={ghostBtn} title="이 환경 삭제">삭제</button>
                  </div>
                  {/* key={selected} — 환경을 바꿀 때만 새 초기값으로 리마운트. 같은 환경 편집 중엔
                      로컬 rows 가 source of truth 라 작성 중(빈 키) 행이 store 갱신에 덮여 사라지지 않는다. */}
                  <VarEditor readOnly={editingBlocked} key={selected} onDraftChange={setDraft} initial={vars} onChange={(v) => setVars(selected, v)} missingKeys={missingKeys} />
                  <details style={{ flexShrink: 0, borderTop: '1px solid var(--fl-border)', marginTop: 8, paddingTop: 8 }}><summary style={{ ...hint, margin: 0, cursor: 'pointer' }}>다른 환경과 변수 비교</summary><div style={{ paddingTop: 8 }}>
                    <label style={hint}>환경 비교 <select aria-label="비교할 환경" style={mono} value={compare} onChange={event => setCompare(event.target.value)}><option value="">비교 환경 선택</option>{names.filter(name => name !== selected).map(name => <option key={name}>{name}</option>)}</select></label>
                    {compare && store.envs[compare] && <div style={{ maxHeight: 180, overflow: 'auto', marginTop: 8 }}>
                      {[...new Set([...Object.keys(vars), ...Object.keys(store.envs[compare])])].sort().filter(key => vars[key] !== store.envs[compare][key]).map(key => <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(100px,1fr) minmax(100px,1fr) minmax(100px,1fr)', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--fl-border)', fontSize: 12 }}><code style={{ overflowWrap: 'anywhere' }}>{key}</code><span style={{ overflowWrap: 'anywhere' }}>{selected}: {Object.hasOwn(vars, key) ? vars[key] || '(빈 값)' : '키 없음'}</span><span style={{ overflowWrap: 'anywhere' }}>{compare}: {Object.hasOwn(store.envs[compare], key) ? store.envs[compare][key] || '(빈 값)' : '키 없음'}</span></div>)}
                      {!Object.keys({ ...vars, ...store.envs[compare] }).some(key => vars[key] !== store.envs[compare][key]) && <p style={hint}>두 환경의 변수 키와 값이 같습니다.</p>}
                    </div>}
                  </div></details>
                  {!compact && (store.active === selected
                    ? <p style={{ ...hint, color: 'var(--fl-ok)' }}>✓ 활성 환경 — 실행 시 이 변수들이 주입됩니다.</p>
                    : <p style={hint}>이 환경을 쓰려면 왼쪽 라디오로 <b>활성화</b>하세요.</p>)}
                </>
              ) : (
                <div style={empty}>왼쪽에서 환경을 선택하세요.</div>
              )}
            </div>
          </div>
        )}

        {onClose && <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button style={primaryBtn} onClick={onClose}>닫기</button>
        </div>}
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </div>
  )
}

/**
 * 환경 변수 행 편집기 — 순수 문자열 키/값(토큰·바인딩 없음). rows 가 편집 중 source of truth.
 * initial 은 마운트 시점 초기값으로만 쓰고 이후 prop 변화를 재반영하지 않는다(부모가 key={환경}로 리마운트).
 * → 빈 키(작성 중) 행이 자신의 onChange 로 인한 store 갱신에 덮여 사라지는 유실 버그 방지.
 */
function VarEditor({ initial, onChange, missingKeys, onDraftChange, readOnly = false }: { readOnly?: boolean; onDraftChange?: (dirty: boolean) => void; initial: Record<string, string>; onChange: (v: Record<string, string>) => void; missingKeys?: string[] }) {
  // 삽입 순서 보존을 위해 배열로 편집 후 맵으로 직렬화
  const [rows, setRows] = useState<Array<{ k: string; v: string }>>(() => Object.entries(initial).map(([k, v]) => ({ k, v })))
  const [filter, setFilter] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  // 텍스트 모드 — 행을 하나씩 추가하는 대신 .env 텍스트로 통편집(변수가 많을 때 훨씬 빠르다)
  const [mode, setMode] = useState<'form' | 'text'>('form')
  const [text, setText] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<string | null>(null) // rows 반영 후 포커스할 input 의 data-var 값

  const commit = (next: Array<{ k: string; v: string }>) => {
    setRows(next)
    const out: Record<string, string> = {}
    for (const { k, v } of next) if (k.trim()) out[k.trim()] = v
    if (!duplicateKeys(next.map(row => row.k)).size && !next.some(row => (!row.k.trim() && !!row.v) || (row.k.trim() && !/^[A-Za-z_][\w.-]*$/.test(row.k.trim())))) onChange(out)
  }
  const toTextMode = () => {
    setText(rows.filter((r) => r.k.trim()).map((r) => `${r.k.trim()}=${r.v}`).join('\n'))
    setMode('text')
  }
  const textErrors = validateDotEnv(text)
  const pasteErrors = validateDotEnv(pasteText)
  const applyText = () => {
    if (textErrors.length) return
    commit(parseDotEnv(text).map(p => ({ k: p.key, v: p.value })))
    setMode('form')
    toast('텍스트 변경을 적용했습니다.', 'ok')
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
    if (pasteErrors.length) return
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
  const invalidRows = dup.size > 0 || rows.some(row => !row.k.trim() && !!row.v || row.k.trim() && !/^[A-Za-z_][\w.-]*$/.test(row.k.trim()))
  const draft = invalidRows || mode === 'text' || pasteOpen && !!pasteText
  useEffect(() => { onDraftChange?.(draft); return () => onDraftChange?.(false) }, [draft, onDraftChange])
  useEffect(() => { if (!draft) return; const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave) }, [draft])
  const f = filter.trim().toLowerCase()
  const visible = rows.map((r, i) => ({ r, i })).filter(({ r }) => !f || r.k.toLowerCase().includes(f) || r.v.toLowerCase().includes(f))

  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}><div ref={boxRef} style={{ overflowY: 'auto', minHeight: 0, flex: 1, paddingRight: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span role="status" style={{ ...hint, marginTop: 0, flex: 1 }}>{f ? `검색 ${visible.length} / ` : '변수 '}{rows.filter((r) => r.k.trim()).length}개{dup.size > 0 ? ` · 중복 키 ${dup.size}개` : ''}</span>
        <div role="group" aria-label="편집 방식" style={seg}>
          <button disabled={mode === 'text'} aria-pressed={mode === 'form'} onClick={() => setMode('form')} style={{ ...segBtn, ...(mode === 'form' ? segOn : null) }}>폼</button>
          <button disabled={mode === 'text'} aria-pressed={mode === 'text'} onClick={toTextMode} style={{ ...segBtn, ...(mode === 'text' ? segOn : null) }} title="KEY=value 텍스트로 한꺼번에 편집">텍스트</button>
        </div>
      </div>

      {mode === 'text' ? (
        <>
          <textarea
            disabled={readOnly} value={text} onChange={(e) => setText(e.target.value)} autoFocus
            aria-label="환경 변수 텍스트 편집"
            placeholder={'baseUrl=https://dev.api.example.com\ntoken=abc123'}
            style={{ ...mono, width: '100%', minHeight: 240, fontFamily: 'var(--fl-font-mono)', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.7 }}
          />
          <p style={hint}>한 줄에 하나(<code style={code}>키=값</code>). 적용하면 기존 변수 전체를 교체합니다.</p>
          {textErrors.length > 0 && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>{textErrors.join(' · ')}</p>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}><button disabled={readOnly || textErrors.length > 0} style={primaryBtn} onClick={applyText}>변수 전체 교체 적용</button><button style={ghostBtn} onClick={() => setMode('form')}>취소</button></div>
        </>
      ) : (
      <>
      {(dup.size > 0 || rows.some(row => row.k.trim() && !/^[A-Za-z_][\w.-]*$/.test(row.k.trim()))) && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>중복 키와 이름 형식 오류를 수정하세요. 오류가 있는 변경은 저장되지 않습니다.</p>}
      {rows.length === 0 && <p style={{ ...hint, marginTop: 2 }}>변수를 추가하세요 (예: <code style={code}>baseUrl</code> = <code style={code}>https://dev.api.example.com</code>).</p>}
      {(rows.length >= 8 || filter) && (
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`키 또는 값 검색… (${rows.length}개)`} aria-label="변수 검색"
          style={{ ...mono, width: '100%', marginBottom: 6, fontFamily: 'var(--fl-font-ui)', boxSizing: 'border-box', position: 'sticky', top: 0, zIndex: 1 }} />
      )}
      {f && visible.length === 0 && <p style={{ ...hint, marginTop: 2 }}>검색과 일치하는 변수가 없습니다.</p>}
      {visible.length > 0 && <div className="fl-variable-column-head" aria-hidden="true"><span>변수 키</span><span>값</span><span /></div>}
      {visible.map(({ r, i }) => (
        <div key={i} className="fl-variable-row">
          {r.k.length > 34 && <code style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 12, color: 'var(--fl-text-muted)', marginBottom: 5 }}>{r.k}</code>}
          <div className="fl-variable-fields">
          <input
            style={{ ...mono, flex: 1, fontFamily: 'var(--fl-font-mono)', ...(r.k.trim() && dup.has(r.k.trim()) ? dupWarn : null) }}
            disabled={readOnly} value={r.k} placeholder="키" data-var={`k${i}`} aria-label={`${i + 1}번째 변수 키`}
            title={r.k.trim() && dup.has(r.k.trim()) ? '중복 키 — 수정 전까지 저장되지 않습니다' : undefined}
            onChange={(e) => setRow(i, { k: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); boxRef.current?.querySelector<HTMLInputElement>(`[data-var="v${i}"]`)?.focus() } }}
          />
          <input
            disabled={readOnly} style={{ ...mono, flex: 1.8, fontFamily: 'var(--fl-font-mono)' }} value={r.v} placeholder="값" data-var={`v${i}`} aria-label={`${r.k || `${i + 1}번째 변수`} 값`}
            onChange={(e) => setRow(i, { v: e.target.value })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              // Enter = 다음 행으로, 마지막 행이면 새 행 추가 — 여러 변수를 손 안 떼고 입력
              if (i === rows.length - 1) addRow()
              else boxRef.current?.querySelector<HTMLInputElement>(`[data-var="k${i + 1}"]`)?.focus()
            }}
          />
          <button disabled={readOnly} onClick={() => delRow(i)} aria-label="변수 삭제" style={delBtn}>×</button>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6 }}>
        <button disabled={readOnly} onClick={addRow} style={addBtn}>+ 변수</button>
        <button disabled={readOnly} onClick={() => setPasteOpen((v) => !v)} style={addBtn} title="KEY=value 여러 줄(.env 형식)을 한 번에 붙여넣어 추가">.env 붙여넣기</button>
      </div>
      {/* 환경 간 키 누락 감지 — 다른 환경에는 있는데 여기 없는 키를 빈 값으로 한 번에 추가 */}
      {(() => {
        const missing = (missingKeys ?? []).filter((k) => !rows.some((r) => r.k.trim() === k))
        if (missing.length === 0) return null
        return (
          <p style={{ ...hint, marginTop: 8 }}>
            다른 환경에는 있는데 여기 없는 키 <b>{missing.length}개</b>:{' '}
            <code style={code}>{missing.slice(0, 8).join(', ')}{missing.length > 8 ? ' …' : ''}</code>{' '}
            <button disabled={readOnly} onClick={() => commit([...rows, ...missing.map((k) => ({ k, v: '' }))])}
              style={{ ...addBtn, marginTop: 0, padding: '2px 8px', fontSize: 12 }} title="누락 키를 빈 값 행으로 추가 — 값만 채우면 됩니다">
              + 빈 값으로 추가
            </button>
          </p>
        )
      })()}
      {pasteOpen && (
        <div style={{ marginTop: 6 }}>
          <textarea
            disabled={readOnly} value={pasteText} onChange={(e) => setPasteText(e.target.value)} autoFocus
            placeholder={'baseUrl=https://dev.api.example.com\ntoken=abc123\n# 주석·빈 줄은 무시'}
            aria-label=".env 붙여넣기"
            style={{ ...mono, width: '100%', minHeight: 84, fontFamily: 'var(--fl-font-mono)', resize: 'vertical', boxSizing: 'border-box' }}
          />
          {pasteErrors.length > 0 && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>{pasteErrors.join(' · ')}</p>}
          <p style={hint}>{parseDotEnv(pasteText).length}개 변수 · 기존 키 {parseDotEnv(pasteText).filter(item => rows.some(row => row.k.trim() === item.key)).length}개 값 교체</p>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button disabled={readOnly || pasteErrors.length > 0 || !pasteText.trim()} onClick={applyPaste} style={{ ...primaryBtn, padding: '6px 12px', fontSize: 12 }}>추가</button>
            <button onClick={() => { setPasteOpen(false); setPasteText('') }} style={ghostBtn}>취소</button>
            <span style={{ ...hint, alignSelf: 'center', marginTop: 0 }}>같은 키는 값이 갱신됩니다.</span>
          </div>
        </div>
      )}
      </>
      )}
    </div></fieldset>
  )
}

const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 6 }
const mono: CSSProperties = { padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, minWidth: 0 }
const xBtn: CSSProperties = { ...ui.close, width: 28, height: 28 }
const primaryBtn: CSSProperties = { ...ui.primary }
const ghostBtn: CSSProperties = { ...ui.secondary }
const addBtn: CSSProperties = { ...ui.dashed, marginTop: 2 }
const delBtn: CSSProperties = { ...ui.icon, width: 30, flexShrink: 0 }
const dupWarn: CSSProperties = { borderColor: 'var(--fl-put)', boxShadow: '0 0 0 1px var(--fl-put) inset' }
const seg: CSSProperties = { display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }
const segBtn: CSSProperties = { padding: '4px 12px', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12 }
const segOn: CSSProperties = { background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontWeight: 600 }
const countBadge: CSSProperties = { flexShrink: 0, fontSize: 11, color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius)', padding: '1px 6px' }
const empty: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--fl-text-muted)', fontSize: 13, padding: 24 }
