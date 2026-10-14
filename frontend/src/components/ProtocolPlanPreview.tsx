import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ProtocolPhase, ProtocolSpec } from '../api/types'
import { useCentralApi, useWorkspace } from '../app/WorkspaceContext'
import { useEnvironment, useEnvStore } from '../lib/environments'
import { fieldsOf, parseProtocolContext } from '../lib/protocolSpec'
import { ui } from '../design/ui'
import { CompilationFeedback, ProtocolRequestError, ValidationMessages } from './CompilationFeedback'
import { RuntimeCapabilitiesPanel } from './RuntimeCapabilitiesPanel'

const phases: [ProtocolPhase, string][] = [['request', '요청'], ['requestAck', '요청 ACK'], ['response', '응답'], ['responseAck', '응답 ACK']]

export function ProtocolValidationPanel({ spec }: { spec: ProtocolSpec }) {
  const { protocolsApi } = useCentralApi()
  const { remoteKey } = useWorkspace()
  const signature = JSON.stringify([remoteKey, spec]), current = useRef(signature); current.current = signature
  const validation = useMutation({ mutationFn: async (snapshot: string) => ({ snapshot, result: await protocolsApi.validate(JSON.parse(snapshot)[1]) }) })
  return <section style={section} aria-label="프로토콜 통합 검증"><h3 style={title}>저장 전 통합 검증</h3>
    <p style={hint}>거래 조건·길이·ACK·코덱·필수 바인딩을 같은 서버 컴파일러로 확인합니다. 정의 저장, 버전 생성, 전송은 하지 않습니다.</p>
    <RuntimeCapabilitiesPanel />
    <button style={ui.secondary} disabled={validation.isPending} onClick={() => validation.mutate(signature)}>{validation.isPending ? '검증 중…' : '현재 정의 검증'}</button>
    {validation.isError && validation.variables === signature && <ProtocolRequestError error={validation.error} />}
    {validation.data?.snapshot === current.current && <CompilationFeedback report={validation.data.result} />}
    {validation.data && validation.data.snapshot !== signature && <p role="status" style={hint}>정의가 바뀌었습니다. 현재 내용으로 다시 검증하세요.</p>}
  </section>
}

export function ProtocolPlanPreview({ spec, selectionRef }: { spec: ProtocolSpec; selectionRef: RefObject<HTMLSelectElement | null> }) {
  const { protocolsApi } = useCentralApi()
  const { remoteKey } = useWorkspace()
  const envStore = useEnvStore('server')
  const { ensureEnvLoaded, activeEnvName } = useEnvironment('server')
  const [transactionKey, setTransaction] = useState(spec.transactions?.[0]?.key ?? '')
  const [phase, setPhase] = useState<ProtocolPhase>('request')
  const [action, setAction] = useState<'assemble' | 'parse'>('assemble')
  const [values, setValues] = useState<Record<string, string>>({})
  const [requestFields, setRequestFields] = useState('{}'), [responseFields, setResponseFields] = useState('{}')
  const [bytesB64, setBytes] = useState('')
  const transaction = spec.transactions?.find(entry => entry.key === transactionKey)
  const messageKey = phase === 'request' ? transaction?.requestMessage : transaction?.responseMessage
  const ack = phase === 'requestAck' ? transaction?.requestAck : transaction?.responseAck
  const isAck = phase.endsWith('Ack')
  const fields = isAck ? [] : fieldsOf(spec, messageKey)
  useEffect(() => { setValues({}) }, [transactionKey, phase])
  const signature = JSON.stringify([remoteKey, spec, transactionKey, phase, action, values, requestFields, responseFields, bytesB64, envStore.active])
  const current = useRef(signature); current.current = signature
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preview = useMutation({ mutationFn: async (snapshot: string) => {
    const request = { spec: structuredClone(spec), transactionKey, phase, action, environment: activeEnvName(),
      requestFields: parseProtocolContext(requestFields), responseFields: parseProtocolContext(responseFields),
      ...(action === 'parse' ? { bytesB64 } : { values: Object.fromEntries(fields.filter(field => field.type !== 'length').map(field => [field.name, values[field.name] ?? (phase === 'request' ? transaction?.when.find(condition => condition.field === field.name)?.value : undefined) ?? ''])) }) }
    await ensureEnvLoaded()
    if (!mounted.current || current.current !== snapshot) return undefined
    const result = await protocolsApi.preview(request)
    return mounted.current && current.current === snapshot ? { snapshot, result } : undefined
  } })
  const result = preview.data?.snapshot === signature ? preview.data.result : undefined
  return <section style={section} aria-label="거래·ACK 미리보기"><h3 style={title}>거래·ACK 미리보기</h3>
    <p style={hint}>편집 중인 정의를 저장·전송 없이 조립하거나 바이트를 해석합니다. 승인된 코덱과 저장된 서버 환경을 사용하며 환경 값도 저장하지 않습니다.</p>
    <form onSubmit={event => { event.preventDefault(); if (transaction && (!isAck || ack) && !preview.isPending) preview.mutate(signature) }}>
      <div style={row}><select ref={selectionRef} aria-label="미리보기 거래" style={input} value={transactionKey} onChange={event => { setTransaction(event.target.value); setPhase('request') }}><option value="">거래 선택</option>{spec.transactions?.map(entry => <option key={entry.key} value={entry.key}>{entry.key}</option>)}</select>
        <select aria-label="미리보기 단계" style={input} value={phase} onChange={event => setPhase(event.target.value as ProtocolPhase)}>{phases.map(([key, label]) => <option key={key} value={key} disabled={key === 'requestAck' ? !transaction?.requestAck : key === 'responseAck' ? !transaction?.responseAck : false}>{label}{key.endsWith('Ack') && !(key === 'requestAck' ? transaction?.requestAck : transaction?.responseAck) ? ' · 생략' : ''}</option>)}</select>
        <select aria-label="미리보기 동작" style={input} value={action} onChange={event => setAction(event.target.value as 'assemble' | 'parse')}><option value="assemble">필드로 조립</option><option value="parse">바이트 해석·검증</option></select>
      </div>
      {action === 'parse' ? <label style={hint}>수신한 완전한 프레임 · Base64<textarea aria-label="해석할 전문 Base64" style={{ ...input, ...area }} rows={4} value={bytesB64} onChange={event => setBytes(event.target.value)} placeholder="실제 시크릿을 포함하지 않는 합성 바이트로 시험하세요." /></label> : isAck ? <p style={hint}>선택한 ACK 송신 정의로 조립합니다. 아래에 그 거래의 원 요청·응답 값을 넣으세요.</p> : <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflow: 'auto' }}>{fields.map(field => <label key={field.name} style={row}><span style={{ overflowWrap: 'anywhere' }}>{field.name} · {field.len} B</span><input aria-label={`미리보기 ${field.name}`} style={{ ...input, flex: '1 1 180px' }} value={values[field.name] ?? ''} disabled={field.type === 'length'} placeholder={field.type === 'length' ? '길이 자동 계산' : transaction?.when.some(condition => condition.field === field.name) ? '거래 조건은 미입력 시 자동 적용' : '필수 값 · 정수는 10진 문자열'} onChange={event => setValues({ ...values, [field.name]: event.target.value })} /></label>)}</div>}
      <details open={isAck} style={{ margin: '12px 0' }}><summary>원 요청·응답 컨텍스트</summary><label style={hint}>요청 req · 문자열 JSON 객체<textarea aria-label="원 요청 필드 JSON" style={{ ...input, ...area }} rows={3} value={requestFields} onChange={event => setRequestFields(event.target.value)} /></label><label style={hint}>응답 res · 문자열 JSON 객체<textarea aria-label="원 응답 필드 JSON" style={{ ...input, ...area }} rows={3} value={responseFields} onChange={event => setResponseFields(event.target.value)} /></label></details>
      <button style={ui.primary} disabled={!transaction || (isAck && !ack) || preview.isPending || (action === 'parse' && !bytesB64.trim())}>{preview.isPending ? '확인 중…' : action === 'parse' ? '해석·검증' : '조립'}</button>
    </form>
    {preview.isError && preview.variables === signature && <ProtocolRequestError error={preview.error} />}
    {preview.data && !result && <p role="status" style={hint}>입력이 바뀌었습니다. 현재 입력으로 다시 확인하세요.</p>}
    {result && <div style={{ display: 'grid', gap: 8, marginTop: 12 }}><strong>{result.transactionKey} · {result.phase} · 실제 {result.wireLength ?? result.total} B{result.declaredLength != null ? ` · 선언 ${result.declaredLength} B · 보정 ${result.lengthAdjustment ?? 0} B` : ''}</strong>
      <ValidationMessages errors={result.errors ?? []} />{result.warnings?.map((warning, index) => <p key={index} style={hint}>{warning}</p>)}
      <div style={hint}>{result.fields.map(field => <div key={field.name}>@{field.offset} · {field.name} · {field.actualBytes}/{field.len} B · {field.value}{field.warn && ` · ${field.warn}`}</div>)}</div>
      <b>HEX</b><pre style={pre}>{result.hex}</pre><b>텍스트</b><pre style={pre}>{result.text}</pre>{result.bytesB64 && <><b>Base64 · 마스킹 적용</b><pre style={pre}>{result.bytesB64}</pre></>}
    </div>}
  </section>
}
const section = { padding: 16, minWidth: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)' }
const title = { margin: '0 0 10px', fontSize: 15 }
const hint = { fontSize: 12, lineHeight: 1.7, color: 'var(--fl-text-muted)', overflowWrap: 'anywhere' as const }
const row = { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 8, marginBottom: 8, minWidth: 0, fontSize: 13 }
const input = { padding: '7px 9px', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' as const, color: 'var(--fl-text)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', font: 'inherit', fontSize: 13 }
const area = { display: 'block', width: '100%', fontFamily: 'var(--fl-font-mono)', resize: 'vertical' as const }
const pre = { margin: 0, padding: 10, maxHeight: 240, overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const, background: 'var(--fl-surface-2)' }
