import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { MockServerSpec, MockTcpRuleSpec, ProtocolSpec } from '../api/types'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { fieldsOf, requestKeys } from '../lib/protocolSpec'
import { fixtureResponseValues, makeTcpFixture } from '../lib/mockFixture'
import { apiErrorMessage } from '../lib/apiError'
import { newId } from '../lib/ids'
import { ui } from '../design/ui'
import { CompilationFeedback, ProtocolRequestError, ValidationMessages } from './CompilationFeedback'
import { RuntimeCapabilitiesPanel } from './RuntimeCapabilitiesPanel'

function stringMap(text: string): Record<string, string> {
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error('문자열 값으로 구성된 JSON 객체를 입력하세요.')
  return value
}
export function MockPlanPreview({ id, slug, type, spec, protocol, readOnly, onAddRule }: {
  id: string; slug: string; type: 'HTTP' | 'TCP'; spec: MockServerSpec; protocol?: ProtocolSpec; readOnly: boolean; onAddRule: (rule: MockTcpRuleSpec) => void
}) {
  const { mocksApi } = useApi()
  const { scopeKey } = useWorkspace()
  const [key, setKey] = useState(() => protocol ? requestKeys(protocol)[0]?.key ?? '' : '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [requestMode, setRequestMode] = useState<'fields' | 'bytes'>('fields'), [bytes, setBytes] = useState('')
  const [method, setMethod] = useState(spec.routes?.[0]?.method === 'ANY' ? 'POST' : spec.routes?.[0]?.method ?? 'POST')
  const [path, setPath] = useState(spec.routes?.[0]?.path ?? '/')
  const [headers, setHeaders] = useState('{}'), [query, setQuery] = useState('{}'), [body, setBody] = useState('{}')
  const transaction = protocol?.transactions?.find(entry => entry.requestMessage === key)
  const signature = JSON.stringify([scopeKey, id, spec, key, values, requestMode, bytes, method, path, headers, query, body])
  const current = useRef(signature); current.current = signature
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const definition = JSON.stringify([scopeKey, id, spec]), definitionRef = useRef(definition); definitionRef.current = definition
  const validate = useMutation({ mutationFn: async (snapshot: string) => ({ snapshot, result: await mocksApi.validate(spec) }) })
  const preview = useMutation({ mutationFn: async (snapshot: string) => {
    let request: Record<string, unknown>
    if (type === 'TCP') {
      if (requestMode === 'bytes') request = { bytesB64: bytes }
      else {
        if (!key) throw new Error('합성 요청 전문을 선택하세요.')
        request = { key, values: protocol ? Object.fromEntries(fieldsOf(protocol, key).filter(field => field.type !== 'length').map(field => [field.name, values[field.name] ?? transaction?.when.find(condition => condition.field === field.name)?.value ?? ''])) : values }
      }
    } else {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('외부 URL 대신 /로 시작하는 Mock 경로를 입력하세요.')
      let parsedBody: unknown = body
      try { parsedBody = JSON.parse(body) } catch { /* HTTP 텍스트 본문은 그대로 사용한다. */ }
      request = { method, path, headers: stringMap(headers), query: stringMap(query), body: parsedBody }
    }
    const result = await mocksApi.preview({ spec: structuredClone(spec), slug, type, environment: spec.environment, request })
    return mounted.current && current.current === snapshot ? { snapshot, result } : undefined
  } })
  const result = preview.data?.snapshot === signature ? preview.data.result : undefined
  return <section style={section} aria-label="Mock 저장 전 검증과 미리보기">
    <h2 style={heading}>저장 전 검증 · 응답 미리보기</h2>
    <p style={hint}>합성 요청으로 선택 거래·매칭 규칙·응답·ACK 계획을 확인합니다. 저장·리스너 시작·외부 요청·콜백 발사·상태와 카운터 변경은 하지 않습니다.</p>
    <RuntimeCapabilitiesPanel />
    <button style={ui.secondary} disabled={validate.isPending} onClick={() => validate.mutate(definition)}>{validate.isPending ? '검증 중…' : '현재 Mock 정의 검증'}</button>
    {validate.isError && validate.variables === definition && <ProtocolRequestError error={validate.error} />}
    {validate.data?.snapshot === definitionRef.current && <CompilationFeedback report={validate.data.result} />}
    <form style={{ marginTop: 20 }} onSubmit={event => { event.preventDefault(); if (!preview.isPending) preview.mutate(signature) }}>
      {type === 'TCP' ? <>
        <div style={row}><label style={row}>합성 요청 방식<select aria-label="Mock 합성 요청 방식" style={input} value={requestMode} onChange={event => setRequestMode(event.target.value as 'fields' | 'bytes')}><option value="fields">필드로 요청 구성</option><option value="bytes">수신 바이트 해석</option></select></label>
          {requestMode === 'fields' && <select aria-label="Mock 미리보기 요청 전문" style={input} value={key} onChange={event => { setKey(event.target.value); setValues({}) }}><option value="">요청 전문 선택</option>{protocol && requestKeys(protocol).map(message => <option key={message.key} value={message.key}>{message.label}</option>)}</select>}
        </div>
        {!protocol && <p role="status" style={hint}>연결 설정에서 프로토콜을 선택하고 조회를 완료하세요. 읽지 못한 규격을 빈 정의로 대신하지 않습니다.</p>}
        {requestMode === 'bytes' ? <textarea aria-label="Mock 합성 요청 Base64" rows={4} style={{ ...input, ...area }} value={bytes} onChange={event => setBytes(event.target.value)} placeholder="완전한 프레임의 Base64" /> : <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflow: 'auto' }}>{protocol && fieldsOf(protocol, key).map(field => <label key={field.name} style={row}><span style={{ overflowWrap: 'anywhere' }}>{field.name} · {field.len} B</span><input aria-label={`합성 요청 ${field.name}`} style={{ ...input, flex: '1 1 160px' }} value={values[field.name] ?? transaction?.when.find(condition => condition.field === field.name)?.value ?? ''} disabled={field.type === 'length'} placeholder={field.type === 'length' ? '길이 자동 계산' : '필수 값 · 8 B 정수도 문자열 입력'} onChange={event => setValues({ ...values, [field.name]: event.target.value })} /></label>)}</div>}
      </> : <>
        <div style={row}><select aria-label="합성 HTTP 메서드" style={input} value={method} onChange={event => setMethod(event.target.value)}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map(value => <option key={value}>{value}</option>)}</select><input aria-label="합성 HTTP 경로" style={{ ...input, flex: '1 1 180px' }} value={path} onChange={event => setPath(event.target.value)} placeholder="/offline-van/cancel" /></div>
        <label style={hint}>합성 본문 · JSON 또는 텍스트<textarea aria-label="합성 HTTP 본문" style={{ ...input, ...area }} rows={5} value={body} onChange={event => setBody(event.target.value)} /></label>
        <details><summary>헤더 · 쿼리</summary><label style={hint}>헤더 JSON<textarea aria-label="합성 HTTP 헤더" style={{ ...input, ...area }} rows={3} value={headers} onChange={event => setHeaders(event.target.value)} /></label><label style={hint}>쿼리 JSON<textarea aria-label="합성 HTTP 쿼리" style={{ ...input, ...area }} rows={3} value={query} onChange={event => setQuery(event.target.value)} /></label></details>
      </>}
      <button style={{ ...ui.primary, marginTop: 12 }} disabled={preview.isPending || (type === 'TCP' && (!protocol || (requestMode === 'fields' ? !key : !bytes.trim())))}>{preview.isPending ? '미리보는 중…' : '응답 미리보기 · 전송 없음'}</button>
    </form>
    {preview.isError && preview.variables === signature && <ProtocolRequestError error={preview.error} />}
    {preview.data && !result && <p role="status" style={hint}>입력이나 정의가 바뀌었습니다. 다시 미리보세요.</p>}
    {result && <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
      <strong role="status">{result.transactionKey && `거래 ${result.transactionKey} · `}{result.ruleId ? `매칭 규칙 ${result.ruleId}` : '매칭 규칙 없음'} · 저장·전송 없음</strong>
      <ValidationMessages errors={result.validations ?? []} />{result.warnings?.map((warning, index) => <p key={index} style={hint}>{warning}</p>)}
      <div style={hint}>필요 기능 · {result.requiredCapabilities?.join(', ') || '결과의 의존성 확인'}</div>
      {result.steps?.map((step, index) => <div key={index} style={{ ...hint, border: '1px solid var(--fl-border)', padding: 8 }}><b>{step.phase} · {step.role} · {step.direction || '—'} · {step.status}</b><br />{step.actualBytes} B{step.expectedBytes != null && ` / 기대 ${step.expectedBytes} B`}{step.validationMode && ` · ${step.validationMode}`}{step.errorCode && ` · ${step.errorCode}`}</div>)}
      <h3 style={heading}>정규화 요청</h3><pre style={pre}>{JSON.stringify(result.request, null, 2)}</pre><h3 style={heading}>예상 응답</h3><pre style={pre}>{JSON.stringify(result.response, null, 2)}</pre>
      <details><summary>읽은 상태와 의존성</summary><pre style={pre}>{JSON.stringify({ snapshot: result.snapshot, compiledSummary: result.compiledSummary }, null, 2)}</pre></details>
    </div>}
    {type === 'TCP' && protocol && <TcpFixtureBuilder key={spec.tcp?.protocolId} protocol={protocol} requestKey={key} requestValues={{ ...Object.fromEntries((transaction?.when ?? []).map(condition => [condition.field, condition.value])), ...values }} readOnly={readOnly} onAddRule={onAddRule} />}
  </section>
}

function TcpFixtureBuilder({ protocol, requestKey, requestValues, readOnly, onAddRule }: { protocol: ProtocolSpec; requestKey: string; requestValues: Record<string, string>; readOnly: boolean; onAddRule: (rule: MockTcpRuleSpec) => void }) {
  const transaction = protocol.transactions?.find(entry => entry.requestMessage === requestKey)
  const [responseKey, setResponse] = useState(transaction?.responseMessage ?? '')
  useEffect(() => { setResponse(transaction?.responseMessage ?? '') }, [requestKey, transaction?.responseMessage])
  const [mode, setMode] = useState<'success' | 'strict'>('success')
  const defaults = fixtureResponseValues(protocol, requestKey, responseKey)
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const fields = drafts[responseKey] ?? defaults
  const [successField, setSuccessField] = useState(''), [successValue, setSuccessValue] = useState('')
  const [error, setError] = useState('')
  const responseFields = responseKey ? fieldsOf(protocol, responseKey).filter(field => field.type !== 'length') : []
  return <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--fl-border)' }}><h3 style={heading}>응답 fixture 작성</h3>
    <p style={hint}>등록된 전문과 직접 지정한 성공 코드·합성 값으로 규칙 초안을 만듭니다. 같은 이름의 요청 값은 참조로 제안합니다. 추가한 초안은 Mock 편집의 자동 저장 설정을 따릅니다.</p>
    <div style={row}><select aria-label="fixture 작성 모드" style={input} value={mode} disabled={readOnly} onChange={event => setMode(event.target.value as 'success' | 'strict')}><option value="success">성공 응답용</option><option value="strict">프로토콜 검증용</option></select>
      <select aria-label="fixture 응답 전문" style={input} value={responseKey} disabled={readOnly || !!transaction} onChange={event => setResponse(event.target.value)}><option value="">응답 전문 선택</option>{protocol.messages.map(message => <option key={message.key} value={message.key}>{message.key} · {message.label}</option>)}</select>
    </div>
    <p style={hint}>{mode === 'success' ? '명시한 거래 조건에 성공 응답을 반환합니다. 프레임·필수 필드·코덱 오류는 성공으로 바꾸지 않습니다.' : '위 합성 요청에 직접 입력한 필드도 일치 조건으로 추가합니다. ACK의 HEX·필드 정밀 검증은 프로토콜의 거래별 ACK에서 정하세요.'} OTP·PASS의 실제 사용자 동작 완료를 보장하지 않습니다.</p>
    {mode === 'success' && <div style={row}><select aria-label="fixture 성공 코드 필드" style={input} value={successField} disabled={readOnly} onChange={event => setSuccessField(event.target.value)}><option value="">성공 코드 필드 선택</option>{responseFields.map(field => <option key={field.name}>{field.name}</option>)}</select><input aria-label="fixture 성공 코드 값" style={input} value={successValue} readOnly={readOnly} placeholder="규격에 정해진 성공 값" onChange={event => setSuccessValue(event.target.value)} /></div>}
    <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflow: 'auto' }}>{responseFields.map(field => <div key={field.name} style={row}><label style={row}><input type="checkbox" aria-label={`fixture ${field.name} 명시`} checked={Object.hasOwn(fields, field.name)} disabled={readOnly || (mode === 'success' && field.name === successField)} onChange={event => { const next = { ...fields }; if (event.target.checked) next[field.name] = ''; else delete next[field.name]; setDrafts({ ...drafts, [responseKey]: next }) }} />{field.name} · {field.len} B</label><input aria-label={`fixture ${field.name} 값`} style={{ ...input, flex: '1 1 180px' }} readOnly={readOnly} value={mode === 'success' && field.name === successField ? successValue : fields[field.name] ?? ''} disabled={mode === 'success' && field.name === successField} placeholder="상수 또는 {{req.필드}} · 빈 값은 체크로 명시" onChange={event => setDrafts({ ...drafts, [responseKey]: { ...fields, [field.name]: event.target.value } })} /></div>)}</div>
    {error && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>{error}</p>}
    <button style={{ ...ui.secondary, marginTop: 12 }} disabled={readOnly || !requestKey || !responseKey} onClick={() => { try { const rule = makeTcpFixture(protocol, requestKey, responseKey, fields, newId(), mode, requestValues, successField, successValue); setError(''); onAddRule(rule) } catch (error) { setError(apiErrorMessage(error)) } }}>명시한 값으로 규칙 초안 추가</button>
  </div>
}
const section = { padding: 18, minWidth: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const heading = { margin: '0 0 10px', fontSize: 16 }
const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const, minWidth: 0, marginBottom: 8, fontSize: 13 }
const hint = { margin: '6px 0 10px', fontSize: 12, lineHeight: 1.7, color: 'var(--fl-text-muted)', overflowWrap: 'anywhere' as const }
const input = { padding: '7px 9px', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' as const, color: 'var(--fl-text)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', font: 'inherit', fontSize: 13 }
const area = { display: 'block', width: '100%', fontFamily: 'var(--fl-font-mono)', resize: 'vertical' as const }
const pre = { margin: 0, padding: 10, maxHeight: 300, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, background: 'var(--fl-surface-2)' }
