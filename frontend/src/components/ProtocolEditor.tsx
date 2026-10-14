import { useCentralApi, useWorkspace } from '../app/WorkspaceContext'
// frontend/src/components/ProtocolEditor.tsx — 프로토콜(고정길이 전문 규격) 편집기.
// 기본(인코딩) · 프레이밍(길이 필드/형식/포함 여부/분기 필드) · 헤더 표 · 전문 표(탭·표 붙여넣기) ·
// 메시지 플러그인 체인 · 미리보기(백엔드 조립). 저장 전까지는 전부 로컬 spec 편집.
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSProperties, RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import type { CodecInfo, PluginRef, ProtocolDetail, ProtocolField, ProtocolFraming, ProtocolSpec } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { AssistantLoginGate } from './AssistantLoginGate'
import { ProtocolAssistantPanel } from './ProtocolAssistantPanel'
import { fieldsOf, framingOf, lengthNumbers, parsePastedTable, previewDirection, splitPasted, tableLen, tcpOption, validateTcpSettings } from '../lib/protocolSpec'
import { apiErrorMessage } from '../lib/apiError'
import { AskDialog } from './AskDialog'
import type { AskSpec } from './AskDialog'
import { Modal } from './Modal'
import { FieldTable, ParamsForm } from './ProtocolFieldTable'
import { useEnvironment, useEnvStore } from '../lib/environments'
import { toast } from './toast'
import { ResourceScopeNote } from './ResourceScopeNote'
import { useUnsavedNavigation } from './UnsavedNavigation'
import { ui } from '../design/ui'
import { relTime } from '../lib/format'
import { ProtocolTransactionsEditor } from './ProtocolTransactionsEditor'
import { ProtocolPlanPreview, ProtocolValidationPanel } from './ProtocolPlanPreview'

const ENCODINGS = ['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII']

export function ProtocolEditor({ detail, canEdit, onSaved }: { detail: ProtocolDetail; canEdit: boolean; onSaved: () => void }) {
  const { adminApi, codecsApi, protocolsApi } = useCentralApi()
  const scope = useWorkspace()
  const pluginsAllowed = true

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [name, setName] = useState(detail.name)
  const [spec, setSpecRaw] = useState<ProtocolSpec>(() => structuredClone(detail.spec))
  const [dirty, setDirty] = useState(false)
  const draftRef = useRef({ name, spec }); draftRef.current = { name, spec }
  const activeRef = useRef(true)
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false } }, [])
  const [tab, setTab] = useState(detail.spec.messages[0]?.key ?? '')
  const [errors, setErrors] = useState<string[]>([])
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [pasting, setPasting] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [messageSearch, setMessageSearch] = useState('')
  const previewSelect = useRef<HTMLSelectElement>(null)
  const { isGuest, desktop } = useAuth()
  const aiMe = useQuery({ queryKey: ['admin', 'me', 'central', scope.remoteKey], queryFn: adminApi.me, enabled: !desktop && scope.connected, staleTime: 30_000 })
  const aiPending = !desktop && aiMe.data?.myStatus === 'PENDING'
  const ro = !canEdit

  const setSpec = (s: ProtocolSpec) => { setSpecRaw(s); setDirty(true) }
  const patch = (p: Partial<ProtocolSpec>) => setSpec({ ...spec, ...p })
  const msg = spec.messages.find((m) => m.key === tab)
  const patchMsg = (p: Partial<{ key: string; label: string; fields: ProtocolField[] }>) =>
    patch({ messages: spec.messages.map((m) => (m.key === tab ? { ...m, ...p } : m)) })

  const codecs = useQuery({ queryKey: ['codecs', 'central', scope.remoteKey], queryFn: codecsApi.list, enabled: scope.connected, staleTime: 300_000 })
  const codecList = useMemo(() => codecs.data ?? [], [codecs.data])

  const save = useMutation({
    mutationFn: async () => {
      const snapshot = structuredClone(draftRef.current)
      const invalid = validateTcpSettings(snapshot.spec)
      if (invalid.length) throw new Error(invalid.join('\n'))
      await protocolsApi.update(detail.id, snapshot)
      return snapshot
    },
    onSuccess: (snapshot) => {
      if (!activeRef.current) return
      const unchanged = JSON.stringify(draftRef.current) === JSON.stringify(snapshot)
      setDirty(!unchanged); setErrors([])
      toast(unchanged ? '저장됨' : '이전 변경은 저장됐습니다. 추가 편집을 저장하세요.', 'ok'); onSaved()
    },
    onError: (e) => setErrors([apiErrorMessage(e)]),
  })
  const { navigateSaved } = useUnsavedNavigation({ dirty, saving: save.isPending, label: '전문 규격' })
  const duplicate = useMutation({
    mutationFn: () => protocolsApi.create(`${name} (복제)`, spec),
    onSuccess: (d) => { onSaved(); navigate(`/protocols/${d.id}`) },
    onError: (e) => setErrors([apiErrorMessage(e)]),
  })
  const remove = useMutation({
    mutationFn: () => protocolsApi.remove(detail.id),
    onSuccess: () => { setDirty(false); onSaved(); navigateSaved(`/protocols?space=${encodeURIComponent(`${scope.current.origin}:${scope.current.id}`)}`) },
    onError: (e) => setErrors([apiErrorMessage(e)]),
  })

  // Ctrl/Cmd+S 저장 — 물리 키(e.code)로 판정해 한글 입력 모드에서도 동작
  const saveRef = useRef(() => {})
  saveRef.current = () => { if (canEdit && dirty && !save.isPending) save.mutate() }
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.key === 's')) { e.preventDefault(); saveRef.current() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  // ?add=KEY — Mock 전문 로그의 "이 코드로 본문 정의 만들기" 진입: 없는 전문이면 빈 정의를 만들고 그 탭으로
  useEffect(() => {
    const add = searchParams.get('add')
    if (!add || !canEdit) return
    setSpecRaw((cur) => {
      if (cur.messages.some((m) => m.key === add)) return cur
      setDirty(true)
      return { ...cur, messages: [...cur.messages, { key: add, label: '', fields: [] }] }
    })
    setTab(add)
    const next = new URLSearchParams(searchParams)
    next.delete('add')
    next.set('space', `${scope.current.origin}:${scope.current.id}`)
    navigateSaved(`/protocols/${detail.id}?${next}`, { replace: true })
  }, [searchParams, navigateSaved, detail.id, scope.current.origin, scope.current.id, canEdit])
  // 미저장 이탈 경고
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const headerLen = tableLen(spec.header)
  const bodyLen = msg ? tableLen(msg.fields) : 0
  const nums = lengthNumbers(spec, tab)
  const lengthFields = spec.header.filter((f) => f.type === 'length')
  const usesLength = (spec.schemaVersion === 2 ? (spec.transactions ?? []).flatMap(transaction => [transaction.framing ?? framingOf(spec), transaction.responseFraming ?? framingOf(spec, true)]) : [framingOf(spec), framingOf(spec, true)]).some(frame => tcpOption(frame.mode, 'length') === 'length')
  const oddKeys = spec.schemaVersion !== 2 && !spec.discriminator && spec.messages.some((m) => m.key !== 'request' && m.key !== 'response')

  return (
    <div style={{ height: '100%', overflowY: 'auto', minWidth: 0, width: '100%', boxSizing: 'border-box' }}>
      {aiOpen && (isGuest || aiPending
        ? <AssistantLoginGate reason={isGuest ? 'guest' : 'pending'} variant="overlay" onClose={() => setAiOpen(false)} />
        : <ProtocolAssistantPanel spec={spec} onClose={() => setAiOpen(false)}
            onApply={(s) => { setSpec(s); if (!s.messages.some((m) => m.key === tab)) setTab(s.messages[0]?.key ?? '') }} />)}
      <div style={topBar}>
        <input aria-label="프로토콜 이름" value={name} disabled={ro}
          onChange={(e) => { setName(e.target.value); setDirty(true) }}
          style={{ ...nameInput, ...(ro ? { cursor: 'default' } : null) }} />
        {dirty && <span style={dirtyBadge}>● 미저장</span>}
        <span style={{ flex: 1 }} />
        <button type="button" style={ghostBtn} disabled={!spec.messages.length} title={!spec.messages.length ? '미리볼 전문을 먼저 추가하세요.' : '미리보기 입력으로 이동합니다. 저장·전송 없이 확인하려면 아래에서 조립을 누르세요.'} onClick={() => { previewSelect.current?.scrollIntoView({ block: 'center' }); previewSelect.current?.focus({ preventScroll: true }) }}>전문 미리보기</button>
        {canEdit && <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} style={{ ...primaryBtn, ...(dirty ? null : { opacity: 0.5 }) }} title="Ctrl+S">{save.isPending ? '저장 중…' : '저장'}</button>}
        {canEdit && <button onClick={() => duplicate.mutate()} disabled={duplicate.isPending} style={ghostBtn}>복제</button>}
        {canEdit && <button onClick={() => setAiOpen((v) => !v)} style={{ ...ghostBtn, border: '1px solid var(--fl-primary)', color: 'var(--fl-primary)' }} title="명세서 표를 붙여넣거나 말로 설명하면 프로토콜을 만들어 줍니다">✨ AI</button>}
        {canEdit && (
          <button style={{ ...ghostBtn, color: 'var(--fl-fail)' }}
            onClick={() => setAsk({ title: '프로토콜 삭제', message: `"${name}" 을 삭제합니다. 이 프로토콜을 쓰는 TCP 노드·Mock 은 참조가 끊깁니다. 계속할까요?`, confirmLabel: '삭제', danger: true, onConfirm: () => remove.mutate() })}>삭제</button>
        )}
      </div>

      {ro && <div style={{ ...banner, background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)' }}>읽기 전용 — 편집 권한이 없습니다.</div>}
      {errors.length > 0 && <div role="alert" style={{ ...banner, borderColor: 'var(--fl-fail)', color: 'var(--fl-fail)' }}>{errors.map((m, i) => <div key={i}>⚠ {m}</div>)}</div>}

      <div style={{ padding: '4px 20px 60px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 18 }}>
        <ResourceScopeNote central />
        <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }} title={detail.updatedAt ?? detail.createdAt}>최근 저장 {relTime(detail.updatedAt ?? detail.createdAt)}</span>
        {/* ① 기본 */}
        <section style={section}>
          <div style={secTitle}>기본</div>
          <label style={row}>
            <span style={lbl}>인코딩</span>
            <select aria-label="프로토콜 인코딩" value={spec.encoding} disabled={ro} onChange={(e) => patch({ encoding: e.target.value })} style={sel}>
              {ENCODINGS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <span style={hint}>한글이 들어가는 사내 전문은 보통 EUC-KR 입니다.</span>
          </label>
        </section>

        {/* ② 프레이밍 */}
        <section style={section}>
          <div style={secTitle}>TCP 송수신</div>
          <TransportEditor spec={spec} patch={patch} readOnly={ro} />
        </section>
        <ProtocolTransactionsEditor spec={spec} patch={patch} readOnly={ro} codecs={codecList} frameEditor={(label, frame, onChange) => <FrameControls label={label} frame={frame} readOnly={ro} onChange={onChange} />} />
        <section style={section}>
          <div style={secTitle}>{usesLength ? '길이 필드와 전문 구분' : '전문 구분'}</div>
          {usesLength && <>
          <p style={hint}>길이 필드 방식에 사용하는 설정입니다. 고정 길이·끝 구분자 방식은 길이 필드 없이도 사용할 수 있습니다.</p>
          <label style={row}>
            <span style={lbl}>길이 필드</span>
            <select aria-label="길이 필드" value={spec.lengthField} disabled={ro || !lengthFields.length} onChange={(e) => patch({ lengthField: e.target.value })} style={sel}>
              {!lengthFields.some((f) => f.name === spec.lengthField) && <option value={spec.lengthField}>{spec.lengthField || '(없음)'}</option>}
              {!!spec.lengthField && <option value="">(없음)</option>}
              {lengthFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.len}B)</option>)}
            </select>
            {!lengthFields.length && <span style={{ ...hint, color: 'var(--fl-warn, #b8860b)' }}>길이 필드 방식에는 헤더의 length 타입 필드가 필요합니다.</span>}
          </label>
          <label style={row}>
            <span style={lbl}>길이 형식</span>
            <select aria-label="길이 형식" value={tcpOption(spec.lengthFormat, 'ascii-decimal')} disabled={ro} onChange={(e) => patch({ lengthFormat: e.target.value as ProtocolSpec['lengthFormat'] })} style={sel}>
              <option value="ascii-decimal">ascii-decimal (0057)</option>
              <option value="ascii-hex">ascii-hex (0039)</option>
              <option value="binary">binary (00 39)</option>
            </select>
            {tcpOption(spec.lengthFormat, 'ascii-decimal') === 'binary' && (
              <select aria-label="엔디안" value={tcpOption(spec.endian, 'big')} disabled={ro} onChange={(e) => patch({ endian: e.target.value as 'big' | 'little' })} style={sel}>
                <option value="big">big endian</option>
                <option value="little">little endian</option>
              </select>
            )}
          </label>
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <span style={lbl}>길이 값</span>
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>길이 보정을 비워 둔 경우의 기본값 (현재 전문 {tab || '—'})</div>
              <label style={radioRow}>
                <input type="radio" name="includesSelf" checked={!spec.includesSelf} disabled={ro} onChange={() => patch({ includesSelf: false })} />
                <b style={mono}>{nums.bodyOnly}</b> <span style={hint}>(전문길이 필드 제외)</span>
              </label>
              <label style={radioRow}>
                <input type="radio" name="includesSelf" checked={spec.includesSelf} disabled={ro} onChange={() => patch({ includesSelf: true })} />
                <b style={mono}>{nums.withSelf}</b> <span style={hint}>(전문길이 필드 포함)</span>
              </label>
            </div>
          </div>
          </>}
          <label style={row}>
            <span style={lbl}>{spec.schemaVersion === 2 ? 'v1 분기 필드' : '분기 필드'}</span>
            <select aria-label="분기 필드" value={spec.discriminator} disabled={ro} onChange={(e) => patch({ discriminator: e.target.value })} style={sel}>
              <option value="">{spec.schemaVersion === 2 ? '(없음 — 거래의 요청·응답 전문 사용)' : '(없음 — request/response)'}</option>
              {!!spec.discriminator && !spec.header.some((f) => f.name === spec.discriminator) && <option value={spec.discriminator}>{spec.discriminator} (헤더에 없음)</option>}
              {spec.header.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
            {oddKeys && <span style={{ ...hint, color: 'var(--fl-warn, #b8860b)' }}>⚠ 분기 필드가 없으면 전문 key 는 request/response 여야 합니다.</span>}
          </label>
        </section>

        {/* ③ 헤더 */}
        <section style={section}>
          <div style={secTitle}>헤더 <span style={{ ...mono, color: 'var(--fl-text-muted)', fontWeight: 400 }}>{headerLen} bytes</span></div>
          <FieldTable fields={spec.header} onChange={(header) => patch({ header })} baseOffset={0} codecs={codecList} pluginsAllowed={pluginsAllowed} readOnly={ro} lengthField={spec.lengthField} />
        </section>

        {/* ④ 전문 */}
        <section style={section}>
          <div style={secTitle}>전문 <span style={hint}>{spec.messages.length}개</span></div>
          {(spec.messages.length > 5 || messageSearch) && <input type="search" aria-label="전문 key 또는 이름 검색" value={messageSearch} onChange={e => setMessageSearch(e.target.value)} placeholder="전문 key 또는 이름 검색" style={{ ...input, width: 'min(420px, 100%)', marginBottom: 8, boxSizing: 'border-box' }} />}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10, maxHeight: 170, overflowY: 'auto', padding: 2 }}>
            {spec.messages.filter(m => `${m.key} ${m.label ?? ''}`.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase())).map((m) => (
              <button key={m.key} aria-pressed={m.key === tab} title={`${m.key} · ${m.label ?? ''}`} onClick={() => setTab(m.key)} style={{ ...tabBtn, ...(m.key === tab ? tabOn : null), maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <b style={mono}>{m.key}</b>{m.label ? ` · ${m.label}` : ''}
              </button>
            ))}
            {messageSearch && !spec.messages.some(m => `${m.key} ${m.label ?? ''}`.toLocaleLowerCase().includes(messageSearch.trim().toLocaleLowerCase())) && <p role="status" style={hint}>일치하는 전문이 없습니다.</p>}
            {canEdit && (
              <button style={tabBtn} onClick={() => setAsk({
                title: '전문 추가', input: { label: '전문 key (예: 0210 — 분기 필드 값)', placeholder: '0210' }, confirmLabel: '추가',
                onConfirm: (key) => {
                  if (spec.messages.some((m) => m.key === key)) { toast('같은 key 의 전문이 이미 있습니다', 'error'); return }
                  patch({ messages: [...spec.messages, { key, label: '', fields: [] }] })
                  setTab(key); setMessageSearch('')
                },
              })}>+ 전문 추가</button>
            )}
          </div>

          {!msg ? (
            <div style={hint}>전문을 선택하세요.</div>
          ) : (
            <>
              <div style={{ ...row, flexWrap: 'wrap', marginBottom: 10 }}>
                <input aria-label="전문 key" value={msg.key} disabled={ro}
                  onChange={(e) => { const key = e.target.value; patchMsg({ key }); setTab(key) }} style={{ ...input, width: 110, fontFamily: 'var(--fl-font-mono)' }} />
                <input aria-label="전문 이름" value={msg.label ?? ''} disabled={ro} placeholder="이름 (예: 잔액조회 요청)"
                  onChange={(e) => patchMsg({ label: e.target.value })} style={{ ...input, width: 200 }} />
                <span style={{ flex: 1 }} />
                {canEdit && <button style={miniBtn} onClick={() => setPasting(true)}>표 붙여넣기</button>}
                {canEdit && (
                  <button style={miniBtn} onClick={() => {
                    let key = `${msg.key}-복사`
                    for (let suffix = 2; spec.messages.some(m => m.key === key); suffix++) key = `${msg.key}-복사-${suffix}`
                    patch({ messages: [...spec.messages, { ...structuredClone(msg), key }] })
                    setTab(key); setMessageSearch('')
                  }}>복제</button>
                )}
                {canEdit && spec.messages.length > 1 && (
                  <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => setAsk({
                    title: '전문 삭제', message: `전문 "${msg.key}" 를 삭제합니다.`, confirmLabel: '삭제', danger: true,
                    onConfirm: () => {
                      const rest = spec.messages.filter((m) => m.key !== msg.key)
                      patch({ messages: rest })
                      setTab(rest[0]?.key ?? '')
                    },
                  })}>삭제</button>
                )}
              </div>
              <FieldTable key={msg.key} fields={msg.fields} onChange={(fields) => patchMsg({ fields })} baseOffset={headerLen} codecs={codecList} pluginsAllowed={pluginsAllowed} readOnly={ro}
                lengthField={spec.lengthField} reservedNames={spec.header.map((f) => f.name)} />
              <div style={{ ...mono, fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 8 }}>본문 {bodyLen} / 전체 {headerLen + bodyLen} bytes</div>
            </>
          )}
        </section>

        {/* ⑤ 메시지 플러그인 */}
        {pluginsAllowed ? <MessagePlugins spec={spec} patch={patch} codecs={codecList} readOnly={ro} /> : (spec.messagePlugins?.length ?? 0) > 0 && <section style={section}><p>플러그인은 공용·팀 공간에서만 사용할 수 있습니다.</p><button disabled={ro} onClick={() => patch({ messagePlugins: [] })}>기존 메시지 플러그인 제거</button></section>}

        {/* ⑥ 미리보기 */}
        <ProtocolValidationPanel spec={spec} />
        {spec.schemaVersion === 2 ? <ProtocolPlanPreview spec={spec} selectionRef={previewSelect} /> : <PreviewSection spec={spec} tab={tab} selectionRef={previewSelect} />}
      </div>

      {pasting && msg && (
        <PasteDialog header={spec.header} onClose={() => setPasting(false)}
          onApply={(header, fields) => { setSpec({ ...spec, ...(header ? { header } : null), messages: spec.messages.map((m) => (m.key === tab ? { ...m, fields } : m)) }); setPasting(false) }} />
      )}
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </div>
  )
}

/** 요청과 응답의 경계·연결·ACK를 프로토콜 한 곳에서 정의한다. */
export function TransportEditor({ spec, patch, readOnly }: { spec: ProtocolSpec; patch: (p: Partial<ProtocolSpec>) => void; readOnly: boolean }) {
  const setFrame = (response: boolean, value: ProtocolFraming) => patch(response ? { responseFraming: value } : { framing: value })
  const transport = spec.transport ?? {}
  const connection = tcpOption(transport.connection, 'once')
  const invalid = validateTcpSettings(spec)
  return <div style={{ display: 'grid', gap: 14 }}>
    <p style={{ ...hint, margin: 0 }}>{spec.schemaVersion === 2 ? '거래별 경계와 ACK가 우선합니다. 아래 공통 경계는 해당 거래에서 공통 경계를 선택한 경우에만 사용합니다.' : '한 전문의 끝을 어디서 판단할지 정하세요. 요청과 응답의 길이 방식이 다르면 응답을 따로 설정할 수 있습니다.'}</p>
    <details open={spec.schemaVersion !== 2 || !!spec.framing || !!spec.responseFraming}>
      <summary style={{ fontSize: 13, cursor: 'pointer' }}>공통 기본 경계</summary>
      <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
    <FrameControls label="요청" frame={framingOf(spec)} readOnly={readOnly} onChange={value => setFrame(false, value)} />
    <label style={radioRow}>
      <input type="checkbox" checked={!spec.responseFraming} disabled={readOnly} onChange={e => patch({ responseFraming: e.target.checked ? undefined : { ...framingOf(spec) } })} />
      응답 경계는 요청과 동일
    </label>
    {spec.responseFraming && <FrameControls label="응답" frame={spec.responseFraming} readOnly={readOnly} onChange={value => setFrame(true, value)} />}
      </div>
    </details>
    <label style={row}>
      <span style={lbl}>연결 방식</span>
      <select aria-label="TCP 연결 방식" style={sel} value={connection} disabled={readOnly} onChange={e => patch({ transport: { ...transport, connection: e.target.value as 'once' | 'execution' } })}>
        <option value="once">요청마다 연결하고 종료</option>
        <option value="execution">이 실행에서 연결 유지</option>
      </select>
    </label>
    <p style={{ ...hint, margin: 0 }}>{connection === 'execution' ? '같은 실행에서 대상 주소와 프로토콜이 같은 TCP 노드가 연결을 재사용합니다. 실행이 끝나면 종료합니다.' : 'TCP 노드는 응답과 ACK 처리가 끝나면 연결을 종료합니다.'} Mock은 이 설정과 관계없이 같은 연결에서 다음 요청을 받습니다.</p>
    <label style={row}>
      <span style={lbl}>유휴 연결 제한(초)</span>
      <input aria-label="유휴 연결 제한 초" style={{ ...input, width: 145 }} type="number" min={1} max={3600} step={0.001} value={transport.idleTimeoutMs === 0 ? '' : (transport.idleTimeoutMs ?? 30_000) / 1000} readOnly={readOnly} onChange={e => patch({ transport: { ...transport, idleTimeoutMs: Math.round(Number(e.target.value) * 1000) } })} />
      <span style={hint}>1~3,600초 · Mock과 연결을 유지하는 TCP 노드에 적용합니다. 다음 요청 없이 이 시간이 지나면 연결을 종료합니다.</span>
    </label>
    {(spec.schemaVersion !== 2 || !!transport.requestAckHex || !!transport.responseAckHex) && <details open={!!transport.requestAckHex || !!transport.responseAckHex}>
      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>고정 ACK · 4-way 통신</summary>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        {spec.schemaVersion === 2 && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>거래별 ACK와 충돌합니다. 기존 고정 ACK를 비운 뒤 거래별 ACK에서 설정하세요.</p>}
        <p style={{ ...hint, margin: 0 }}>요청 전송 → 요청 ACK 수신 → 응답 수신 → 응답 ACK 전송 순서입니다. 규격에 없는 ACK는 비워 두세요.</p>
        <label style={row}><span style={lbl}>요청 ACK</span><input aria-label="요청 ACK 기대값 HEX" style={{ ...input, width: 220, fontFamily: 'var(--fl-font-mono)' }} value={transport.requestAckHex ?? ''} placeholder="예: 06" readOnly={readOnly} onChange={e => patch({ transport: { ...transport, requestAckHex: e.target.value || undefined } })} /><span style={hint}>서버에서 받을 정확한 바이트 · HEX · 최대 1,024 B</span></label>
        <label style={row}><span style={lbl}>응답 ACK</span><input aria-label="응답 ACK 송신값 HEX" style={{ ...input, width: 220, fontFamily: 'var(--fl-font-mono)' }} value={transport.responseAckHex ?? ''} placeholder="예: 06" readOnly={readOnly} onChange={e => patch({ transport: { ...transport, responseAckHex: e.target.value || undefined } })} /><span style={hint}>응답을 받은 뒤 보낼 바이트 · HEX · 최대 1,024 B</span></label>
      </div>
    </details>}
    {invalid.length > 0 && <div role="alert" style={{ fontSize: 12, color: 'var(--fl-fail)', lineHeight: 1.7 }}>{invalid.map(message => <div key={message}>{message}</div>)}</div>}
  </div>
}

function FrameControls({ label, frame, readOnly, onChange }: { label: string; frame: ProtocolFraming; readOnly: boolean; onChange: (value: ProtocolFraming) => void }) {
  const mode = tcpOption(frame.mode, 'length')
  return <fieldset style={{ margin: 0, padding: '10px 12px', minWidth: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)' }}>
    <legend style={{ fontSize: 13, fontWeight: 600 }}>{label} 경계</legend>
    <div style={{ display: 'grid', gap: 8 }}>
      <label style={row}><span style={lbl}>경계 방식</span><select aria-label={`${label} 경계 방식`} style={sel} value={mode} disabled={readOnly} onChange={e => onChange({ ...frame, mode: e.target.value as ProtocolFraming['mode'] })}>
        <option value="length">길이 필드</option><option value="fixed">고정 바이트 수</option><option value="delimiter">끝 구분자</option>
      </select></label>
      {mode === 'length' && <>
        <label style={row}><span style={lbl}>길이 보정(B)</span><input aria-label={`${label} 길이 보정 바이트`} style={{ ...input, width: 145 }} type="number" min={-1048576} max={1048576} step={1} value={frame.lengthAdjustment ?? ''} placeholder="기본 포함/제외" readOnly={readOnly} onChange={e => onChange({ ...frame, lengthAdjustment: e.target.value === '' ? undefined : Number(e.target.value) })} /><span style={hint}>선택 · 전체 수신 바이트 = 길이 필드 값 + 보정</span></label>
        <p style={{ ...hint, margin: 0 }}>비워 두면 아래의 길이 필드 포함/제외 설정을 사용합니다. 예: 6 B 접두부를 제외한 길이 값이면 +6, 전체 길이 값이면 0.</p>
      </>}
      {mode === 'fixed' && <>
        <label style={row}><span style={lbl}>고정 길이(B)</span><input aria-label={`${label} 고정 길이 바이트`} style={{ ...input, width: 145 }} type="number" min={1} max={1048576} step={1} value={frame.fixedLength ?? ''} placeholder="예: 128" readOnly={readOnly} onChange={e => onChange({ ...frame, fixedLength: e.target.value === '' ? undefined : Number(e.target.value) })} /><span style={hint}>1~1,048,576 B · 헤더 + 코덱 적용 후 본문</span></label>
        <p style={{ ...hint, margin: 0 }}>지정한 바이트 수를 정확히 받을 때까지 기다립니다. 전송 전문도 이 길이와 일치해야 하며, 문자 수가 아닌 바이트 수입니다.</p>
      </>}
      {mode === 'delimiter' && <>
        <label style={row}><span style={lbl}>끝 구분자(HEX)</span><input aria-label={`${label} 끝 구분자 HEX`} style={{ ...input, width: 220, fontFamily: 'var(--fl-font-mono)' }} value={frame.delimiterHex ?? ''} placeholder="예: 0D 0A" readOnly={readOnly} onChange={e => onChange({ ...frame, delimiterHex: e.target.value })} /><span style={hint}>1~64 B · HEX 두 자리씩</span></label>
        <p style={{ ...hint, margin: 0 }}>송신 끝에 자동으로 붙이고 수신 후 제거합니다. 전문 안에 같은 바이트가 나오면 먼저 끝나므로 본문에 없는 구분자를 사용하세요.</p>
      </>}
    </div>
  </fieldset>
}

/** ⑤ 본문 전체에 순서대로 적용되는 메시지 코덱 체인. */
function MessagePlugins({ spec, patch, codecs, readOnly }: { spec: ProtocolSpec; patch: (p: Partial<ProtocolSpec>) => void; codecs: CodecInfo[]; readOnly: boolean }) {
  const list = spec.messagePlugins ?? []
  const avail = codecs.filter((c) => c.layer === 'message')
  const set = (next: PluginRef[]) => patch({ messagePlugins: next })
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next)
  }
  return (
    <section style={section}>
      <div style={secTitle}>메시지 플러그인</div>
      <div style={{ ...hint, marginBottom: 8 }}>본문 전체에 순서대로 적용(수신은 역순). 헤더는 평문.</div>
      <div style={{ display: 'grid', gap: 6 }}>
        {list.map((p, i) => (
          <div key={i} style={pluginRow}>
            <button aria-label="위로" disabled={readOnly || i === 0} onClick={() => move(i, -1)} style={arrowBtn}>▲</button>
            <button aria-label="아래로" disabled={readOnly || i === list.length - 1} onClick={() => move(i, 1)} style={arrowBtn}>▼</button>
            <b style={{ ...mono, fontSize: 13 }}>{avail.find((c) => c.id === p.id)?.label ?? p.id}</b>
            <ParamsForm params={avail.find((c) => c.id === p.id)?.params ?? []} config={p.config} readOnly={readOnly}
              onChange={(config) => set(list.map((x, j) => (j === i ? { ...x, config } : x)))} />
            <span style={{ flex: 1 }} />
            {!readOnly && <button style={miniBtn} onClick={() => set(list.filter((_, j) => j !== i))}>제거</button>}
          </div>
        ))}
        {!list.length && <div style={hint}>없음 — 본문을 그대로 보냅니다.</div>}
      </div>
      {!readOnly && (
        <select aria-label="플러그인 추가" value="" style={{ ...sel, marginTop: 8 }}
          onChange={(e) => { if (e.target.value) set([...list, { id: e.target.value, config: {} }]) }}>
          <option value="">+ 플러그인 추가…</option>
          {avail.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      )}
    </section>
  )
}

/** ⑥ 백엔드 조립 미리보기 — 저장 없이 현재 편집 중 spec 으로. */
function PreviewSection({ spec, tab, selectionRef }: { spec: ProtocolSpec; tab: string; selectionRef?: RefObject<HTMLSelectElement | null> }) {
  const { activeEnvName, ensureEnvLoaded } = useEnvironment('server')
  const envStore = useEnvStore('server')
  const { scopeKey } = useWorkspace()

  const { protocolsApi } = useCentralApi()

  const [key, setKey] = useState(tab)
  const [frameDirection, setFrameDirection] = useState<'send' | 'recv'>(() => previewDirection(tab))
  const [values, setValues] = useState<Record<string, string>>({})
  const [fieldSearch, setFieldSearch] = useState('')
  const [action, setAction] = useState<'assemble' | 'parse'>('assemble')
  const [bytesB64, setBytesB64] = useState('')
  useEffect(() => { setKey(tab); setFrameDirection(previewDirection(tab)) }, [tab])
  // 전문이 바뀌면 값은 비운다 — 이름이 같아도 다른 전문의 값이 따라오면 안 된다
  useEffect(() => { setValues({}); setFieldSearch('') }, [key])
  const fields = fieldsOf(spec, key)
  // 현재 전문에 있는(길이 자동 제외) 필드만 보낸다 — 전문을 바꾸면 남아 있던 값이 따라가지 않게
  const signature = JSON.stringify([scopeKey, spec, key, frameDirection, values, action, bytesB64, envStore.active, envStore.envs[envStore.active ?? '']])
  const target = useRef(signature)
  target.current = signature
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preview = useMutation({
    mutationFn: async (attempt: string = signature) => {
      const snapshot = attempt
      const current = () => mounted.current && target.current === snapshot
      try {
        await ensureEnvLoaded()
        if (!current()) return undefined
        const result = await protocolsApi.preview({ spec, key, frameDirection, action, environment: activeEnvName(), ...(action === 'parse' ? { bytesB64 } : { values: Object.fromEntries(fields.filter((f) => f.type !== 'length').map((f) => [f.name, values[f.name] ?? ''])) }) })
        return current() ? { signature: snapshot, result } : undefined
      } catch (error) { if (current()) throw error; return undefined }
    },
  })
  const result = preview.data?.signature === signature ? preview.data.result : undefined
  const errOf = (name: string) => result?.errors.find((e) => e.field === name)?.message
  const general = result?.errors.filter((e) => !e.field) ?? []

  return (
    <section style={section}>
      <div style={secTitle}>미리보기</div>
      <form onSubmit={e => { e.preventDefault(); if (key && !preview.isPending && (action !== 'parse' || bytesB64.trim())) preview.mutate(signature) }}>
      <div style={{ ...row, marginBottom: 10 }}>
        <select ref={selectionRef} aria-label="미리보기 전문" value={key} onChange={(e) => { setKey(e.target.value); setFrameDirection(previewDirection(e.target.value)) }} style={sel}>
          {spec.messages.map((m) => <option key={m.key} value={m.key}>{m.key}{m.label ? ` · ${m.label}` : ''}</option>)}
        </select>
        <label style={row}><span style={lbl}>미리보기 방향</span><select aria-label="미리보기 방향" style={sel} value={frameDirection} onChange={e => setFrameDirection(e.target.value as 'send' | 'recv')}>
          <option value="send">요청 전문</option><option value="recv">응답 전문</option>
        </select></label>
        <select aria-label="미리보기 동작" style={sel} value={action} onChange={e => setAction(e.target.value as 'assemble' | 'parse')}><option value="assemble">필드로 조립</option><option value="parse">바이트 해석·검증</option></select>
        <button type="submit" disabled={!key || preview.isPending || (action === 'parse' && !bytesB64.trim())} title={!key ? '조립할 전문을 먼저 선택하세요.' : '저장·전송 없이 현재 입력을 확인합니다. 입력 후 Enter로도 확인할 수 있습니다.'} style={primaryBtn}>{preview.isPending ? '확인 중…' : action === 'parse' ? '해석·검증' : '조립'}</button>
        {preview.isError && preview.variables === signature && <span role="alert" style={{ fontSize: 12, color: 'var(--fl-fail)' }}>⚠ {apiErrorMessage(preview.error)}</span>}
      </div>
      <p style={{ ...hint, margin: '0 0 10px' }}>저장·전송 없이 현재 입력을 확인합니다. 선택한 방향의 경계와 저장된 서버 환경을 사용하며 환경 값도 저장하지 않습니다. 값 입력 후 Enter를 누르세요.</p>
      {action === 'parse' && <textarea aria-label="해석할 전문 Base64" value={bytesB64} onChange={e => setBytesB64(e.target.value)} rows={4} placeholder="수신한 완전한 프레임 · Base64" style={{ ...input, width: '100%', fontFamily: 'var(--fl-font-mono)', marginBottom: 12 }} />}
      {action === 'assemble' && <>
      {(fields.length > 5 || fieldSearch) && <input type="search" aria-label="미리보기 필드 검색" value={fieldSearch} onChange={e => setFieldSearch(e.target.value)} placeholder={`필드 이름 검색 · ${fields.length}개`} style={{ ...input, width: 'min(420px, 100%)', marginBottom: 8, boxSizing: 'border-box' }} />}
      <div style={{ display: 'grid', gap: 5, maxWidth: 880, maxHeight: 320, overflowY: 'auto', padding: 2 }}>
        {fields.filter(f => f.name.toLocaleLowerCase().includes(fieldSearch.trim().toLocaleLowerCase())).map((f) => {
          const auto = f.type === 'length'
          const e = errOf(f.name)
          return (
            <label key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
              <span title={f.name} style={{ ...lbl, width: '35%', minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'var(--fl-font-mono)', fontSize: 12 }}>{f.name}</span>
              <input aria-label={`${f.name} 값`} aria-invalid={!!e} value={auto ? '' : values[f.name] ?? ''} disabled={auto} placeholder={auto ? '자동' : `${f.len}B`}
                onChange={(ev) => setValues({ ...values, [f.name]: ev.target.value })} style={{ ...input, flex: 1, minWidth: 0 }} />
              {e && <span role="alert" style={{ fontSize: 12, color: 'var(--fl-fail)', flexBasis: '100%' }}>⚠ {e}</span>}
            </label>
          )
        })}
        {fieldSearch && !fields.some(f => f.name.toLocaleLowerCase().includes(fieldSearch.trim().toLocaleLowerCase())) && <p role="status" style={hint}>일치하는 필드가 없습니다.</p>}
      </div>
      </>}
      </form>
      {preview.data && !result && <p role="status" style={hint}>입력이나 전문 설정이 바뀌었습니다. 다시 조립해 최신 결과를 확인하세요.</p>}
      {result && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <div style={{ ...mono, fontSize: 13, fontWeight: 700 }}>총 {result.total}B</div>
          {general.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--fl-fail)' }}>⚠ {e.message}</div>)}
          {(result.warnings ?? []).map((w, i) => <div key={i} style={{ fontSize: 12, color: 'var(--fl-warn, #b8860b)' }}>⚠ {w}</div>)}
          <div style={{ display: 'grid', gap: 2, maxHeight: 230, overflowY: 'auto' }}>
            {result.fields.map((f, i) => (
              <div key={i} style={{ ...mono, fontSize: 12, color: 'var(--fl-text-muted)' }}>
                @{f.offset} · <span style={{ color: 'var(--fl-text)' }}>{f.name}</span> · {f.actualBytes}/{f.len} B
                {f.warn && <span style={{ color: 'var(--fl-warn, #b8860b)' }}> ⚠ {f.warn}</span>}
              </div>
            ))}
          </div>
          <div style={{ ...hint, fontWeight: 600 }}>HEX · 조립된 바이트</div>
          <pre style={pre}>{result.hex}</pre>
          <div style={{ ...hint, fontWeight: 600 }}>텍스트 · 제어문자는 표시용으로 변환될 수 있습니다.</div>
          <pre style={pre}>{result.text}</pre>
        </div>
      )}
    </section>
  )
}

/** 명세서 표 붙여넣기 — 파싱 결과와 헤더 대조 경고를 보여주고 본문만/헤더까지 적용. */
function PasteDialog({ header, onClose, onApply }: {
  header: ProtocolField[]
  onClose: () => void
  onApply: (header: ProtocolField[] | null, fields: ProtocolField[]) => void
}) {
  const [text, setText] = useState('')
  const parsed = useMemo(() => parsePastedTable(text), [text])
  const split = useMemo(() => splitPasted(parsed.fields, header), [parsed.fields, header])

  return (
    <Modal onClose={onClose} ariaLabel="표 붙여넣기" width={720} card={{ padding: 18, gap: 12 }} closeOnBackdrop={false}>
      <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 16 }}>표 붙여넣기</div>
      <div style={hint}>명세서 표를 그대로 붙여넣으세요 — 줄마다 <code style={mono}>이름 길이 [타입] [패딩]</code>. 앞 {header.length}개는 헤더로 봅니다.</div>
      <textarea aria-label="전문 필드 표 붙여넣기" value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={8} placeholder={'전문길이\t4\tlength\tleft/zero\n거래코드\t4\tascii\tright/space\n계좌번호\t13\tascii'}
        style={{ ...input, width: '100%', fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical' }} />
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 2 }}>
        {parsed.fields.map((f, i) => (
          <div key={i} style={{ ...mono, fontSize: 12, color: i < header.length ? 'var(--fl-text-muted)' : 'var(--fl-text)' }}>
            {i < header.length ? '헤더' : '본문'} · {f.name} · {f.len}B · {f.type} · {f.pad}
          </div>
        ))}
      </div>
      {split.mismatches.map((m, i) => <div key={i} style={{ fontSize: 12, color: 'var(--fl-warn, #b8860b)' }}>{m}</div>)}
      {parsed.skipped.length > 0 && <div style={hint}>길이를 못 찾아 건너뛴 줄 {parsed.skipped.length}개(제목 줄 등).</div>}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={ghostBtn}>취소</button>
        <button disabled={!parsed.fields.length} style={ghostBtn} onClick={() => onApply(null, split.body)}>본문만 적용</button>
        <button disabled={parsed.fields.length < header.length} style={primaryBtn}
          onClick={() => onApply(parsed.fields.slice(0, header.length), parsed.fields.slice(header.length))}>헤더도 교체</button>
      </div>
    </Modal>
  )
}

// ---------- 스타일 ----------
const topBar: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }
const nameInput: CSSProperties = { padding: '6px 10px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', fontSize: 18, fontWeight: 700, fontFamily: 'var(--fl-font-head)', minWidth: 150, flex: '1 1 240px' }
const dirtyBadge: CSSProperties = { fontSize: 12, fontWeight: 700, color: 'var(--fl-warn, #b8860b)' }
const banner: CSSProperties = { margin: '10px 20px 0', padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, display: 'grid', gap: 3 }
const section: CSSProperties = { padding: 14, minWidth: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const secTitle: CSSProperties = { fontSize: 13, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 8 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8, minWidth: 0 }
const radioRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }
const lbl: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', minWidth: 72 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.6, overflowWrap: 'anywhere' }
const mono: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontVariantNumeric: 'tabular-nums' }
const input: CSSProperties = { padding: '6px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' }
const sel: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', minWidth: 0, maxWidth: '100%' }
const tabBtn: CSSProperties = { ...ui.secondary }
const tabOn: CSSProperties = { background: 'var(--fl-action-primary-bg)', color: 'var(--fl-action-primary-ink)', borderColor: 'var(--fl-primary)' }
const primaryBtn: CSSProperties = { ...ui.primary }
const ghostBtn: CSSProperties = { ...ui.secondary }
const miniBtn: CSSProperties = { ...ui.mini }
const arrowBtn: CSSProperties = { ...ui.icon, width: 21, height: 24 }
const pluginRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
const pre: CSSProperties = { margin: 0, padding: 10, maxHeight: 280, overflow: 'auto', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', fontFamily: 'var(--fl-font-mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--fl-text)' }
