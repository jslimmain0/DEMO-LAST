// frontend/src/components/ProtocolEditor.tsx — 프로토콜(고정길이 전문 규격) 편집기.
// 기본(인코딩) · 프레이밍(길이 필드/형식/포함 여부/분기 필드) · 헤더 표 · 전문 표(탭·표 붙여넣기) ·
// 메시지 플러그인 체인 · 미리보기(백엔드 조립). 저장 전까지는 전부 로컬 spec 편집.
import { useMutation, useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { adminApi, codecsApi, protocolsApi } from '../api/client'
import type { CodecInfo, PluginRef, ProtocolDetail, ProtocolField, ProtocolSpec } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { AssistantLoginGate } from './AssistantLoginGate'
import { ProtocolAssistantPanel } from './ProtocolAssistantPanel'
import { fieldsOf, lengthNumbers, parsePastedTable, splitPasted, tableLen } from '../lib/protocolSpec'
import { apiErrorMessage } from '../lib/apiError'
import { AskDialog } from './AskDialog'
import type { AskSpec } from './AskDialog'
import { Modal } from './Modal'
import { FieldTable, ParamsForm } from './ProtocolFieldTable'
import { toast } from './toast'

const ENCODINGS = ['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII']

export function ProtocolEditor({ detail, canEdit, onSaved }: { detail: ProtocolDetail; canEdit: boolean; onSaved: () => void }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [name, setName] = useState(detail.name)
  const [spec, setSpecRaw] = useState<ProtocolSpec>(() => structuredClone(detail.spec))
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState(detail.spec.messages[0]?.key ?? '')
  const [errors, setErrors] = useState<string[]>([])
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [pasting, setPasting] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const { isGuest } = useAuth()
  const aiMe = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000 })
  const aiPending = aiMe.data?.myStatus === 'PENDING'
  const ro = !canEdit

  const setSpec = (s: ProtocolSpec) => { setSpecRaw(s); setDirty(true) }
  const patch = (p: Partial<ProtocolSpec>) => setSpec({ ...spec, ...p })
  const msg = spec.messages.find((m) => m.key === tab)
  const patchMsg = (p: Partial<{ key: string; label: string; fields: ProtocolField[] }>) =>
    patch({ messages: spec.messages.map((m) => (m.key === tab ? { ...m, ...p } : m)) })

  const codecs = useQuery({ queryKey: ['codecs'], queryFn: codecsApi.list, staleTime: 300_000 })
  const codecList = useMemo(() => codecs.data ?? [], [codecs.data])

  const save = useMutation({
    mutationFn: () => protocolsApi.update(detail.id, { name, spec }),
    onSuccess: () => { setDirty(false); setErrors([]); toast('저장됨', 'ok'); onSaved() },
    onError: (e) => setErrors([apiErrorMessage(e)]),
  })
  const duplicate = useMutation({
    mutationFn: () => protocolsApi.create(`${name} (복제)`, spec),
    onSuccess: (d) => { onSaved(); navigate(`/protocols/${d.id}`) },
    onError: (e) => setErrors([apiErrorMessage(e)]),
  })
  const remove = useMutation({
    mutationFn: () => protocolsApi.remove(detail.id),
    onSuccess: () => { setDirty(false); onSaved(); navigate('/protocols') },
    onError: (e) => setErrors([apiErrorMessage(e)]),
  })

  // Ctrl/Cmd+S 저장 — 물리 키(e.code)로 판정해 한글 입력 모드에서도 동작
  const saveRef = useRef(() => {})
  saveRef.current = () => { if (canEdit && dirty && !save.isPending) save.mutate() }
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.key === 's')) { e.preventDefault(); saveRef.current() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  // ?add=KEY — Mock 전문 로그의 "이 코드로 본문 정의 만들기" 진입: 없는 전문이면 빈 정의를 만들고 그 탭으로
  useEffect(() => {
    const add = searchParams.get('add')
    if (!add) return
    setSpecRaw((cur) => {
      if (cur.messages.some((m) => m.key === add)) return cur
      setDirty(true)
      return { ...cur, messages: [...cur.messages, { key: add, label: '', fields: [] }] }
    })
    setTab(add)
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams])
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
  const oddKeys = !spec.discriminator && spec.messages.some((m) => m.key !== 'request' && m.key !== 'response')

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
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
        {canEdit && <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} style={{ ...primaryBtn, ...(dirty ? null : { opacity: 0.5 }) }} title="Ctrl+S">{save.isPending ? '저장 중…' : '저장'}</button>}
        {canEdit && <button onClick={() => duplicate.mutate()} disabled={duplicate.isPending} style={ghostBtn}>복제</button>}
        {canEdit && <button onClick={() => setAiOpen((v) => !v)} style={{ ...ghostBtn, border: '1px solid var(--fl-primary)', color: 'var(--fl-primary)' }} title="명세서 표를 붙여넣거나 말로 설명하면 프로토콜을 만들어 줍니다">✨ AI</button>}
        {canEdit && (
          <button style={{ ...ghostBtn, color: 'var(--fl-fail)' }}
            onClick={() => setAsk({ title: '프로토콜 삭제', message: `"${name}" 을 삭제합니다. 이 프로토콜을 쓰는 TCP 노드·Mock 은 참조가 끊깁니다. 계속할까요?`, confirmLabel: '삭제', danger: true, onConfirm: () => remove.mutate() })}>삭제</button>
        )}
      </div>

      {ro && <div style={{ ...banner, background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)' }}>읽기 전용 — 편집 권한이 없습니다.</div>}
      {errors.length > 0 && <div style={{ ...banner, borderColor: 'var(--fl-fail)', color: 'var(--fl-fail)' }}>{errors.map((m, i) => <div key={i}>⚠ {m}</div>)}</div>}

      <div style={{ padding: '4px 20px 60px', display: 'grid', gap: 18 }}>
        {/* ① 기본 */}
        <section style={section}>
          <div style={secTitle}>기본</div>
          <label style={row}>
            <span style={lbl}>인코딩</span>
            <select value={spec.encoding} disabled={ro} onChange={(e) => patch({ encoding: e.target.value })} style={sel}>
              {ENCODINGS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <span style={hint}>한글이 들어가는 사내 전문은 보통 EUC-KR 입니다.</span>
          </label>
        </section>

        {/* ② 프레이밍 */}
        <section style={section}>
          <div style={secTitle}>프레이밍</div>
          <label style={row}>
            <span style={lbl}>길이 필드</span>
            <select value={spec.lengthField} disabled={ro || !lengthFields.length} onChange={(e) => patch({ lengthField: e.target.value })} style={sel}>
              {!lengthFields.some((f) => f.name === spec.lengthField) && <option value={spec.lengthField}>{spec.lengthField || '(없음)'}</option>}
              {lengthFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.len}B)</option>)}
            </select>
            {!lengthFields.length && <span style={{ ...hint, color: 'var(--fl-warn, #b8860b)' }}>헤더에 length 타입 필드를 추가하세요.</span>}
          </label>
          <label style={row}>
            <span style={lbl}>길이 형식</span>
            <select value={spec.lengthFormat} disabled={ro} onChange={(e) => patch({ lengthFormat: e.target.value as ProtocolSpec['lengthFormat'] })} style={sel}>
              <option value="ascii-decimal">ascii-decimal (0057)</option>
              <option value="binary">binary (00 39)</option>
            </select>
            {spec.lengthFormat === 'binary' && (
              <select aria-label="엔디안" value={spec.endian ?? 'big'} disabled={ro} onChange={(e) => patch({ endian: e.target.value as 'big' | 'little' })} style={sel}>
                <option value="big">big endian</option>
                <option value="little">little endian</option>
              </select>
            )}
          </label>
          <div style={{ ...row, alignItems: 'flex-start' }}>
            <span style={lbl}>길이 값</span>
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>전문길이 필드에 들어갈 값 (기준: 현재 탭 전문 {tab || '—'})</div>
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
          <label style={row}>
            <span style={lbl}>분기 필드</span>
            <select value={spec.discriminator} disabled={ro} onChange={(e) => patch({ discriminator: e.target.value })} style={sel}>
              <option value="">(없음 — request/response)</option>
              {!!spec.discriminator && !spec.header.some((f) => f.name === spec.discriminator) && <option value={spec.discriminator}>{spec.discriminator} (헤더에 없음)</option>}
              {spec.header.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
            {oddKeys && <span style={{ ...hint, color: 'var(--fl-warn, #b8860b)' }}>⚠ 분기 필드가 없으면 전문 key 는 request/response 여야 합니다.</span>}
          </label>
        </section>

        {/* ③ 헤더 */}
        <section style={section}>
          <div style={secTitle}>헤더 <span style={{ ...mono, color: 'var(--fl-text-muted)', fontWeight: 400 }}>{headerLen} bytes</span></div>
          <FieldTable fields={spec.header} onChange={(header) => patch({ header })} baseOffset={0} codecs={codecList} readOnly={ro} lengthField={spec.lengthField} />
        </section>

        {/* ④ 전문 */}
        <section style={section}>
          <div style={secTitle}>전문</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
            {spec.messages.map((m) => (
              <button key={m.key} onClick={() => setTab(m.key)} style={{ ...tabBtn, ...(m.key === tab ? tabOn : null) }}>
                <b style={mono}>{m.key}</b>{m.label ? ` · ${m.label}` : ''}
              </button>
            ))}
            {canEdit && (
              <button style={tabBtn} onClick={() => setAsk({
                title: '전문 추가', input: { label: '전문 key (예: 0210 — 분기 필드 값)', placeholder: '0210' }, confirmLabel: '추가',
                onConfirm: (key) => {
                  if (spec.messages.some((m) => m.key === key)) { toast('같은 key 의 전문이 이미 있습니다', 'error'); return }
                  patch({ messages: [...spec.messages, { key, label: '', fields: [] }] })
                  setTab(key)
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
                {canEdit && <button style={miniBtn} onClick={() => setPasting(true)}>📋 표 붙여넣기</button>}
                {canEdit && (
                  <button style={miniBtn} onClick={() => {
                    const key = `${msg.key}-복사`
                    patch({ messages: [...spec.messages, { ...structuredClone(msg), key }] })
                    setTab(key)
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
              <FieldTable key={msg.key} fields={msg.fields} onChange={(fields) => patchMsg({ fields })} baseOffset={headerLen} codecs={codecList} readOnly={ro}
                lengthField={spec.lengthField} reservedNames={spec.header.map((f) => f.name)} />
              <div style={{ ...mono, fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 8 }}>본문 {bodyLen} / 전체 {headerLen + bodyLen} bytes</div>
            </>
          )}
        </section>

        {/* ⑤ 메시지 플러그인 */}
        <MessagePlugins spec={spec} patch={patch} codecs={codecList} readOnly={ro} />

        {/* ⑥ 미리보기 */}
        <PreviewSection spec={spec} tab={tab} />
      </div>

      {pasting && msg && (
        <PasteDialog header={spec.header} onClose={() => setPasting(false)}
          onApply={(header, fields) => { setSpec({ ...spec, ...(header ? { header } : null), messages: spec.messages.map((m) => (m.key === tab ? { ...m, fields } : m)) }); setPasting(false) }} />
      )}
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </div>
  )
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
            <b style={{ ...mono, fontSize: 12.5 }}>{avail.find((c) => c.id === p.id)?.label ?? p.id}</b>
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
function PreviewSection({ spec, tab }: { spec: ProtocolSpec; tab: string }) {
  const [key, setKey] = useState(tab)
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => { setKey(tab) }, [tab])
  // 전문이 바뀌면 값은 비운다 — 이름이 같아도 다른 전문의 값이 따라오면 안 된다
  useEffect(() => { setValues({}) }, [key])
  const fields = fieldsOf(spec, key)
  // 현재 전문에 있는(길이 자동 제외) 필드만 보낸다 — 전문을 바꾸면 남아 있던 값이 따라가지 않게
  const preview = useMutation({
    mutationFn: () => protocolsApi.preview({ spec, key, values: Object.fromEntries(fields.filter((f) => f.type !== 'length').map((f) => [f.name, values[f.name] ?? ''])) }),
  })
  const result = preview.data
  const errOf = (name: string) => result?.errors.find((e) => e.field === name)?.message
  const general = result?.errors.filter((e) => !e.field) ?? []

  return (
    <section style={section}>
      <div style={secTitle}>미리보기</div>
      <div style={{ ...row, marginBottom: 10 }}>
        <select aria-label="미리보기 전문" value={key} onChange={(e) => setKey(e.target.value)} style={sel}>
          {spec.messages.map((m) => <option key={m.key} value={m.key}>{m.key}{m.label ? ` · ${m.label}` : ''}</option>)}
        </select>
        <button onClick={() => preview.mutate()} disabled={preview.isPending} style={primaryBtn}>{preview.isPending ? '조립 중…' : '🔍 조립'}</button>
        {preview.isError && <span style={{ fontSize: 12, color: 'var(--fl-fail)' }}>⚠ {apiErrorMessage(preview.error)}</span>}
      </div>
      <div style={{ display: 'grid', gap: 5, maxWidth: 560 }}>
        {fields.map((f) => {
          const auto = f.type === 'length'
          const e = errOf(f.name)
          return (
            <label key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ ...lbl, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }}>{f.name}</span>
              <input aria-label={`${f.name} 값`} value={auto ? '' : values[f.name] ?? ''} disabled={auto} placeholder={auto ? '자동' : `${f.len}B`}
                onChange={(ev) => setValues({ ...values, [f.name]: ev.target.value })} style={{ ...input, flex: 1 }} />
              {e && <span style={{ fontSize: 11.5, color: 'var(--fl-fail)' }}>⚠ {e}</span>}
            </label>
          )
        })}
      </div>
      {result && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <div style={{ ...mono, fontSize: 12.5, fontWeight: 700 }}>총 {result.total}B</div>
          {general.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--fl-fail)' }}>⚠ {e.message}</div>)}
          {(result.warnings ?? []).map((w, i) => <div key={i} style={{ fontSize: 12, color: 'var(--fl-warn, #b8860b)' }}>⚠ {w}</div>)}
          <div style={{ display: 'grid', gap: 2 }}>
            {result.fields.map((f, i) => (
              <div key={i} style={{ ...mono, fontSize: 11.5, color: 'var(--fl-text-muted)' }}>
                @{f.offset} · <span style={{ color: 'var(--fl-text)' }}>{f.name}</span> · {f.actualBytes}/{f.len} B
                {f.warn && <span style={{ color: 'var(--fl-warn, #b8860b)' }}> ⚠ {f.warn}</span>}
              </div>
            ))}
          </div>
          <pre style={pre}>{result.hex}</pre>
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
      <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 16 }}>📋 표 붙여넣기</div>
      <div style={hint}>명세서 표를 그대로 붙여넣으세요 — 줄마다 <code style={mono}>이름 길이 [타입] [패딩]</code>. 앞 {header.length}개는 헤더로 봅니다.</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={8} placeholder={'전문길이\t4\tlength\tleft/zero\n거래코드\t4\tascii\tright/space\n계좌번호\t13\tascii'}
        style={{ ...input, width: '100%', fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical' }} />
      <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 2 }}>
        {parsed.fields.map((f, i) => (
          <div key={i} style={{ ...mono, fontSize: 11.5, color: i < header.length ? 'var(--fl-text-muted)' : 'var(--fl-text)' }}>
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
const topBar: CSSProperties = { position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)' }
const nameInput: CSSProperties = { padding: '6px 10px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', fontSize: 17, fontWeight: 700, fontFamily: 'var(--fl-font-head)', minWidth: 220 }
const dirtyBadge: CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--fl-warn, #b8860b)' }
const banner: CSSProperties = { margin: '10px 20px 0', padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', fontSize: 12.5, display: 'grid', gap: 3 }
const section: CSSProperties = { padding: 14, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const secTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'baseline', gap: 8 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }
const radioRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }
const lbl: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', minWidth: 72 }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)' }
const mono: CSSProperties = { fontFamily: 'var(--fl-font-mono)' }
const input: CSSProperties = { padding: '6px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const sel: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const tabBtn: CSSProperties = { padding: '6px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', fontSize: 12.5, cursor: 'pointer' }
const tabOn: CSSProperties = { background: 'var(--fl-primary)', color: '#fff', borderColor: 'var(--fl-primary)' }
const primaryBtn: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }
const ghostBtn: CSSProperties = { padding: '7px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const arrowBtn: CSSProperties = { width: 21, height: 24, padding: 0, border: '1px solid var(--fl-border)', borderRadius: 4, background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', fontSize: 10, cursor: 'pointer' }
const pluginRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
const pre: CSSProperties = { margin: 0, padding: 10, borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--fl-text)' }
