import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import type { MockCodecInput, MockCodecSpec, MockCodecStep, MockCodecStepTrace, MockCodecTarget, TransformInfo } from '../api/types'
import { mocksApi, transformsApi } from '../api/client'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { apiErrorMessage } from '../lib/apiError'
import { summarizeStep, type CodecSide as Side } from '../lib/mockCodecOps'
import { CodecStepWizard } from './FieldCodecButton'
import { TransformPicker } from './TransformPicker'

/**
 * Mock 코덱 편집(v2) — 요청이 매칭·템플릿에 들어가기 **전**(request) / 응답을 다 만든 뒤 나가기 **전**(response) 적용할 변환 플러그인 단계.
 * 단계 카드는 **한 줄 한국어 요약**으로 접혀 있고(예: "응답 후 · user.name 필드 → Base64 인코딩"), 펼치면 플러그인·범위·입력 포트·파라미터를 고친다.
 * 새 단계는 **위저드**(① 언제 ② 무엇을: 전체/필드 체크/헤더 ③ 플러그인 ④ 값)로 만든다. 필드 하나만 걸 때는 각 필드 옆 ◈ 가 더 빠르다.
 * 서버 전체(spec.codec)·라우트(route.codec)·TCP 모두 같은 컴포넌트. HTTP 는 [시험해보기]로 미저장 코덱을 서버에서 바로 돌려본다.
 */
export function MockCodecEditor({ codec, onChange, readOnly, compact, sources = [], fieldHints, mockId, environment }: {
  codec: MockCodecSpec | null | undefined
  onChange: (c: MockCodecSpec | null) => void
  readOnly?: boolean
  compact?: boolean // 라우트 카드 안(제목 축약)
  sources?: BindableSource[]       // 값 템플릿 데이터 삽입 소스(시크릿·요청 필드…)
  fieldHints?: { request: string[]; response: string[] } // target=fields 후보(예상 본문 키 / TCP 필드명)
  mockId?: string                  // 있으면 [시험해보기](codec-try) 노출 — HTTP 만
  environment?: string | null      // 시크릿 스코프(시험 시 서버에 전달)
}) {
  const transforms = useQuery({ queryKey: ['transforms'], queryFn: transformsApi.list, staleTime: 60_000 })
  const list = transforms.data ?? []
  const c = codec ?? {}
  const [wizard, setWizard] = useState<Side | null>(null)
  const setSide = (side: Side, steps: MockCodecStep[]) => {
    const next: MockCodecSpec = { ...c, [side]: steps.length ? steps : undefined }
    onChange(next.request?.length || next.response?.length ? next : null)
  }
  const hints = fieldHints ?? { request: [], response: [] }
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <CodecSideList title={compact ? '요청 전' : '요청 전 — 요청이 들어오면 매칭·템플릿 전에 적용'} side="request"
        steps={c.request ?? []} list={list} readOnly={readOnly} sources={sources} hints={hints.request} onChange={(s) => setSide('request', s)}
        empty={'요청 본문을 그대로 사용'} onAdd={() => setWizard('request')} adding={wizard === 'request'} />
      <CodecSideList title={compact ? '응답 후' : '응답 후 — 응답을 다 만든 뒤 나가기 전에 적용'} side="response"
        steps={c.response ?? []} list={list} readOnly={readOnly} sources={sources} hints={hints.response} onChange={(s) => setSide('response', s)}
        empty={'렌더된 본문을 그대로 전송'} onAdd={() => setWizard('response')} adding={wizard === 'response'} />
      {wizard && (
        <CodecStepWizard list={list} sources={sources} fieldHints={hints} defaultSide={wizard} onCancel={() => setWizard(null)}
          onAdd={(side, step) => { setSide(side, [...(c[side] ?? []), step]); setWizard(null) }} />
      )}
      {mockId && (c.request?.length || c.response?.length) ? (
        <CodecTryPanel mockId={mockId} codec={c} environment={environment} />
      ) : null}
    </div>
  )
}

function CodecSideList({ title, side, steps, list, readOnly, sources, hints, onChange, empty, onAdd, adding }: {
  title: string; side: Side; steps: MockCodecStep[]; list: TransformInfo[]; readOnly?: boolean
  sources: BindableSource[]; hints: string[]; onChange: (s: MockCodecStep[]) => void; empty: string; onAdd: () => void; adding: boolean
}) {
  const setStep = (i: number, patch: Partial<MockCodecStep>) => onChange(steps.map((s, si) => (si === i ? { ...s, ...patch } : s)))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]; const t = next[i]; next[i] = next[j]; next[j] = t
    onChange(next)
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: side === 'request' ? 'var(--fl-primary)' : 'var(--fl-ok)' }}>{side === 'request' ? '⬇' : '⬆'} {title}</span>
        {steps.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>— {empty}</span>}
        {steps.length > 0 && <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{steps.length}단계 · 위에서부터 순서대로</span>}
        {!readOnly && <button style={{ ...miniBtn, marginLeft: 'auto', ...(adding ? { borderColor: 'var(--fl-primary)', color: 'var(--fl-primary)' } : null) }} onClick={onAdd} title="단계 추가 — 언제 · 무엇을 · 어떤 플러그인 · 값">+ 단계</button>}
      </div>
      {steps.length > 0 && (
        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
          {steps.map((s, i) => (
            <StepCard key={i} step={s} index={i} side={side} list={list} readOnly={readOnly} sources={sources} hints={hints}
              onChange={(patch) => setStep(i, patch)} onMove={(d) => move(i, d)} onRemove={() => onChange(steps.filter((_, si) => si !== i))} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 단계 카드 — 접힘: 한 줄 요약 / 펼침: 상세 편집. */
function StepCard({ step: s, index: i, side, list, readOnly, sources, hints, onChange, onMove, onRemove }: {
  step: MockCodecStep; index: number; side: Side; list: TransformInfo[]; readOnly?: boolean
  sources: BindableSource[]; hints: string[]
  onChange: (patch: Partial<MockCodecStep>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void
}) {
  const [open, setOpen] = useState(!s.id)
  const t = list.find((x) => x.id === s.id)
  const target: MockCodecTarget = s.target ?? 'body'
  const cfg = s.config ?? []
  const cfgVal = (k: string) => cfg.find((kv) => kv.key === k)?.value
  const setCfg = (k: string, v: string) => onChange({ config: [...cfg.filter((kv) => kv.key !== k), { key: k, value: v }] })
  const ports = t?.inputs ?? []
  // 입력 포트별 값 — inputs 에 없으면: 첫 포트(또는 v1 inputKey)=전문, 나머지 빈 값
  const messagePort = s.inputs?.find((x) => x.mode === 'message')?.key ?? s.inputKey ?? ports[0]?.key ?? ''
  const inputOf = (key: string): MockCodecInput => s.inputs?.find((x) => x.key === key) ?? { key, mode: key === messagePort ? 'message' : 'value', value: '' }
  const setInputs = (next: MockCodecInput[]) => onChange({ inputs: next, inputKey: undefined })
  const setMessagePort = (key: string) => setInputs(ports.map((p) => (p.key === key ? { key: p.key, mode: 'message' as const } : { key: p.key, mode: 'value' as const, value: inputOf(p.key).mode === 'value' ? inputOf(p.key).value ?? '' : '' })))
  const setPortValue = (key: string, value: string) => setInputs(ports.map((p) => (p.key === key ? { key, mode: 'value' as const, value } : inputOf(p.key))))
  const fields = s.fields ?? []
  const toggleField = (f: string) => onChange({ fields: fields.includes(f) ? fields.filter((x) => x !== f) : [...fields, f] })
  const customFields = fields.filter((f) => !hints.includes(f))
  const summary = summarizeStep(s, side, list)
  const missing = !s.id || (target === 'fields' && fields.length === 0) || (target === 'header' && !s.header?.trim())
  return (
    <div style={{ border: `1px solid ${missing ? 'var(--fl-fail)' : 'var(--fl-border)'}`, borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px' }}>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`단계 ${i + 1} ${open ? '접기' : '펼치기'}`} style={{ ...miniBtn, border: 'none', background: 'transparent', padding: '2px 4px', fontFamily: 'var(--fl-font-mono)', fontWeight: 700, color: 'var(--fl-text-muted)' }}>{open ? '▾' : '▸'} {i + 1}</button>
        <button onClick={() => setOpen((v) => !v)} style={{ flex: 1, minWidth: 0, textAlign: 'left', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12.5, color: missing ? 'var(--fl-fail)' : 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0 }} title={summary}>
          {summary}{missing ? ' — 설정이 비어 있습니다' : ''}
        </button>
        {!readOnly && <>
          <button style={{ ...miniBtn, padding: '2px 7px' }} onClick={() => onMove(-1)} title="위로">↑</button>
          <button style={{ ...miniBtn, padding: '2px 7px' }} onClick={() => onMove(1)} title="아래로">↓</button>
          <button style={{ ...miniBtn, padding: '2px 7px', color: 'var(--fl-fail)' }} onClick={onRemove} title="단계 삭제">×</button>
        </>}
      </div>
      {open && (
        <div style={{ padding: '4px 10px 10px', borderTop: '1px dashed var(--fl-border)', display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: '6px 10px', alignItems: 'center' }}>
            <span style={stepLbl}>플러그인</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <TransformPicker style={{ flex: 1, minWidth: 220, maxWidth: 420 }} list={list} value={s.id} disabled={readOnly}
                onChange={(id) => { if (id !== s.id) onChange({ id, config: undefined, inputs: undefined, inputKey: undefined, outputKey: undefined }) }} />
              {t && t.outputs.length > 1 && (
                <label style={lbl}>출력
                  <select style={{ ...input, minWidth: 90 }} value={s.outputKey ?? t.outputs[0].key} disabled={readOnly} onChange={(e) => onChange({ outputKey: e.target.value })}>
                    {t.outputs.map((io) => <option key={io.key} value={io.key}>{io.label}</option>)}
                  </select>
                </label>
              )}
            </div>
            {t?.description && <><span /><div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: -4 }}>{t.description}</div></>}

            <span style={stepLbl}>무엇을</span>
            <div>
              <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }} title="적용 범위 — 전체 / 특정 필드만 / 헤더">
                {(['body', 'fields', 'header'] as MockCodecTarget[]).map((tg) => (
                  <button key={tg} disabled={readOnly} onClick={() => onChange({ target: tg })}
                    style={{ padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: target === tg ? 'var(--fl-primary)' : 'transparent', color: target === tg ? '#fff' : 'var(--fl-text-muted)' }}>
                    {tg === 'body' ? '본문 전체' : tg === 'fields' ? '특정 필드만' : '헤더'}
                  </button>
                ))}
              </div>
              {target === 'fields' && (
                <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
                  {hints.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {hints.map((h) => (
                        <label key={h} style={{ ...chipLabel, ...(fields.includes(h) ? chipOn : null) }}><input type="checkbox" disabled={readOnly} checked={fields.includes(h)} onChange={() => toggleField(h)} style={{ display: 'none' }} />{h}</label>
                      ))}
                      {customFields.map((h) => (
                        <label key={h} style={{ ...chipLabel, ...chipOn }} title="직접 입력한 필드 — 클릭해 제거"><input type="checkbox" disabled={readOnly} checked onChange={() => toggleField(h)} style={{ display: 'none' }} />{h} ×</label>
                      ))}
                    </div>
                  )}
                  <FieldsInput value={fields} onChange={(f) => onChange({ fields: f })} disabled={readOnly} hasHints={hints.length > 0} />
                </div>
              )}
              {target === 'header' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                  <input style={{ ...input, width: 200, fontFamily: 'var(--fl-font-mono)' }} value={s.header ?? ''} disabled={readOnly} placeholder="예: X-Signature" onChange={(e) => onChange({ header: e.target.value })} />
                  <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>{side === 'request' ? '이 헤더 값을 변환해 {{ x@header }} 에 반영' : '본문을 입력으로 결과를 이 헤더에 기록(서명 패턴)'}</span>
                </div>
              )}
            </div>

            {(ports.length > 1 || (t?.params.length ?? 0) > 0) && <span style={{ ...stepLbl, alignSelf: 'start', paddingTop: 4 }}>값</span>}
            {(ports.length > 1 || (t?.params.length ?? 0) > 0) && (
              <div style={{ display: 'grid', gap: 4 }}>
                {ports.length > 1 && <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>입력 포트 — 하나는 {target === 'fields' ? '필드 값' : target === 'header' && side === 'request' ? '헤더 값' : '본문'}, 나머지는 값(키·IV 는 {'{ }'} 시크릿)</div>}
                {ports.length > 1 && ports.map((p) => {
                  const inp = inputOf(p.key)
                  const isMsg = inp.mode === 'message'
                  return (
                    <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ ...lbl, minWidth: 90, fontFamily: 'var(--fl-font-mono)' }} title={p.example ? `예: ${p.example}` : undefined}>{p.label} <span style={{ opacity: 0.6 }}>{p.key}</span></span>
                      <label style={{ ...lbl, gap: 3 }}><input type="radio" name={`port-${side}-${i}`} checked={isMsg} disabled={readOnly} onChange={() => setMessagePort(p.key)} />{target === 'header' && side === 'request' ? '헤더 값' : target === 'fields' ? '필드 값' : '본문'}</label>
                      {!isMsg && (
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <TokenInput ariaLabel={`입력 ${p.key}`} value={inp.value ?? ''} sources={sources} placeholder={`값 — 예: {{ ${p.key === 'key' ? 'aesKey' : p.key === 'iv' ? 'aesIv' : p.key}@secret }}`} onChange={(v) => setPortValue(p.key, v)} />
                        </div>
                      )}
                    </div>
                  )
                })}
                {t?.params.map((p) => {
                  const val = cfgVal(p.key) ?? p.defaultValue
                  return (
                    <div key={p.key} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ ...lbl, minWidth: 90 }}>{p.label}</span>
                      {p.type === 'select' && (p.options?.length ?? 0) > 0 ? (
                        <select style={{ ...input, minWidth: 100 }} value={val} disabled={readOnly} onChange={(e) => setCfg(p.key, e.target.value)}>
                          {p.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : p.type === 'number' ? (
                        <input type="number" style={{ ...input, width: 120, fontFamily: 'var(--fl-font-mono)' }} value={val} placeholder={p.placeholder} disabled={readOnly} onChange={(e) => setCfg(p.key, e.target.value)} />
                      ) : (
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <TokenInput ariaLabel={`파라미터 ${p.key}`} value={val} sources={sources} placeholder={p.placeholder || '값 또는 { } 데이터 삽입'} onChange={(v) => setCfg(p.key, v)} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {ports.length === 1 && (t?.params.length ?? 0) === 0 && <><span /><div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>입력 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{ports[0].key}</code> = {target === 'fields' ? '필드 값' : target === 'header' && side === 'request' ? '헤더 값' : '본문'} · 추가 값 없음</div></>}
          </div>
        </div>
      )}
    </div>
  )
}

/** 필드 직접 입력(쉼표 구분) — 로컬 텍스트 상태로 타이핑 중 쉼표/공백을 보존하고 blur/Enter 에 반영. */
function FieldsInput({ value, onChange, disabled, hasHints }: { value: string[]; onChange: (f: string[]) => void; disabled?: boolean; hasHints: boolean }) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const commit = () => { const add = text.split(',').map((x) => x.trim()).filter((x) => x && !value.includes(x)); if (add.length) onChange([...value, ...add]); setText(''); setEditing(false) }
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={text} disabled={disabled}
        placeholder={hasHints ? '목록에 없는 필드 직접 입력 — 쉼표 구분 후 Enter' : '쉼표 구분 — 예: card.no, pin (JSON 점 경로 / urlencoded 키)'}
        onFocus={() => setEditing(true)} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
      {editing && text.trim() && <button style={miniBtn} onMouseDown={(e) => e.preventDefault()} onClick={commit}>추가</button>}
      {!hasHints && value.length > 0 && <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>현재: {value.join(', ')}</span>}
    </div>
  )
}

/** 코덱 시험 — 미저장 코덱을 샘플 전문에 서버에서 적용(실제 시크릿 사용, 결과는 마스킹) → 단계별 입력/출력. */
function CodecTryPanel({ mockId, codec, environment }: { mockId: string; codec: MockCodecSpec; environment?: string | null }) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<Side>(codec.request?.length ? 'request' : 'response')
  const [message, setMessage] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [contentType, setContentType] = useState('application/json')
  const [result, setResult] = useState<{ result: string; headers: Record<string, string>; fields: Record<string, string>; steps: MockCodecStepTrace[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = useMemo(() => {
    const out: Record<string, string> = {}
    for (const line of headersText.split('\n')) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim() }
    return out
  }, [headersText])
  const run = async () => {
    setBusy(true); setErr(null)
    try { setResult(await mocksApi.codecTry(mockId, { codec, environment: environment ?? null, side, message, headers, contentType })) }
    catch (e) { setResult(null); setErr(apiErrorMessage(e, '코덱 시험 실패')) }
    finally { setBusy(false) }
  }
  return (
    <div style={{ border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 10 }}>
      <button style={{ ...miniBtn, fontWeight: 700 }} onClick={() => setOpen((v) => !v)}>{open ? '▾' : '▸'} 🧪 코덱 시험해보기</button>
      <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginLeft: 8 }}>샘플 전문을 넣으면 저장 없이 서버에서 단계별로 돌려 봅니다(시크릿은 실제 값, 결과에선 마스킹)</span>
      {open && (
        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }}>
              {(['request', 'response'] as const).map((sd) => (
                <button key={sd} onClick={() => setSide(sd)} disabled={!(codec[sd]?.length)} style={{ padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: side === sd ? 'var(--fl-primary)' : 'transparent', color: side === sd ? '#fff' : 'var(--fl-text-muted)', opacity: codec[sd]?.length ? 1 : 0.4 }}>{sd === 'request' ? '요청 전' : '응답 후'}</button>
              ))}
            </div>
            <span style={lbl}>Content-Type</span>
            <select style={{ ...input, minWidth: 150 }} value={contentType} onChange={(e) => setContentType(e.target.value)}>
              {['application/json', 'application/x-www-form-urlencoded', 'text/plain', 'application/xml', 'text/html'].map((c) => <option key={c}>{c}</option>)}
            </select>
            <button style={{ ...miniBtn, color: 'var(--fl-primary)', fontWeight: 700, marginLeft: 'auto' }} disabled={busy} onClick={() => { void run() }}>{busy ? '…' : '▶ 실행'}</button>
          </div>
          <textarea style={{ ...input, width: '100%', minHeight: 56, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} value={message} onChange={(e) => setMessage(e.target.value)}
            placeholder={side === 'request' ? '샘플 요청 본문(전문) — 예: {"card":{"no":"…"}}' : '샘플 응답 본문(렌더된 전문) — 예: {"ok":true}'} />
          <textarea style={{ ...input, width: '100%', minHeight: 34, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} value={headersText} onChange={(e) => setHeadersText(e.target.value)}
            placeholder={'헤더(선택) — 줄마다 Key: Value. 요청 전 헤더 대상 단계 시험용'} />
          {err && <div style={{ fontSize: 12, color: 'var(--fl-fail)' }}>{err}</div>}
          {result && (
            <div style={{ display: 'grid', gap: 4 }}>
              {result.steps.map((st, k) => (
                <div key={k} style={{ fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', padding: '4px 8px', border: '1px solid var(--fl-border)', borderRadius: 5, background: 'var(--fl-surface)' }}>
                  <span style={{ color: 'var(--fl-text-muted)' }}>{st.index + 1}. {st.id} · {st.target === 'body' ? '전체' : st.target === 'fields' ? `필드 ${st.field}` : `헤더 ${st.field}`}</span><span />
                  <span style={{ color: 'var(--fl-text-muted)' }}>in</span><span style={{ wordBreak: 'break-all' }}>{st.input || '(빈 값)'}</span>
                  <span style={{ color: 'var(--fl-primary)' }}>out</span><span style={{ wordBreak: 'break-all' }}>{st.output || '(빈 값)'}</span>
                </div>
              ))}
              {result.steps.length === 0 && <div style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>적용된 단계가 없습니다(대상 필드/헤더가 샘플에 없거나 단계가 비어 있음).</div>}
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fl-text-muted)', marginTop: 2 }}>결과 {side === 'request' ? '요청' : '응답'} 본문</div>
              <pre style={pre}>{result.result || '(빈 값)'}</pre>
              {Object.keys(result.headers).length > 0 && <pre style={pre}>{Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}
              {Object.keys(result.fields).length > 0 && <div style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>본문 필드: {Object.entries(result.fields).map(([k, v]) => `${k}=${v}`).join(' · ')}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const lbl: CSSProperties = { fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--fl-text-muted)' }
const stepLbl: CSSProperties = { fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)' }
const input: CSSProperties = { padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const miniBtn: CSSProperties = { padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const pre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto' }
const chipLabel: CSSProperties = { fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', padding: '2px 8px', border: '1px solid var(--fl-border)', borderRadius: 999, cursor: 'pointer', background: 'var(--fl-surface)', color: 'var(--fl-text)' }
const chipOn: CSSProperties = { borderColor: 'var(--fl-primary)', background: 'color-mix(in srgb, var(--fl-primary) 12%, var(--fl-surface))', color: 'var(--fl-primary)', fontWeight: 700 }
