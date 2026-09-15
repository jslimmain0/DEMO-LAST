// frontend/src/panels/TcpNodePanel.tsx — TCP 노드 속성: 프로토콜·전문 선택 → 필드 값 입력(바이트 카운터·ascii 경고) → 미리보기 / 응답 전문 → 출력 키
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import type { GraphNode, NodeOutput, ProtocolField, ProtocolPreview, ProtocolSpec } from '../api/types'
import { protocolsApi } from '../api/client'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { byteLen, fieldsOf, messageKeys, padOf, requestKeys, tableLen, withOffsets } from '../lib/protocolSpec'

type Update = (patch: Partial<GraphNode>) => void

export function useProtocol(id: string | undefined) {
  return useQuery({ queryKey: ['protocol', id], queryFn: () => protocolsApi.get(id!), enabled: !!id, staleTime: 15_000 })
}

/** 응답 전문 키 → outputs(헤더+본문 필드, length 제외). 응답 전문 select 변경 시 node.outputs 를 동기화한다. */
export function outputsFor(spec: ProtocolSpec, key: string | undefined): NodeOutput[] {
  return fieldsOf(spec, key).filter((f) => f.type !== 'length').map((f) => ({ key: f.name, type: 'string' }))
}

export function TcpRequestPanel({ node, update, sources, canEdit, preview, previewErr, onPreview }: {
  node: GraphNode; update: Update; sources: BindableSource[]; canEdit: boolean
  preview: ProtocolPreview | null; previewErr: string | null; onPreview: () => void
}) {
  const protos = useQuery({ queryKey: ['protocols'], queryFn: protocolsApi.list, staleTime: 15_000 })
  const proto = useProtocol(node.protocolId || undefined)
  const spec = proto.data?.spec
  const values = node.tcpValues ?? {}
  const setValue = (name: string, v: string) => update({ tcpValues: { ...values, [name]: v } })
  const msg = spec?.messages.find((m) => m.key === node.tcpMessage)
  const offsets = spec && msg ? withOffsets(spec.header, msg.fields) : []
  // 헤더 필드는 전문 맨 앞 — 자체 오프셋(길이/구분자는 자동 채움이라 편집 목록에서 제외)
  const headerRows = spec ? withOffsets([], spec.header).map((off, i) => ({ f: spec.header[i], off })).filter(({ f }) => f.type !== 'length' && f.name !== spec.discriminator) : []
  const errFor = (name: string) => preview?.errors.find((e) => e.field === name)?.message
  return (
    <>
      <label style={label}>대상 (host:port)</label>
      <HostPortInput node={node} update={update} canEdit={canEdit} />
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          <label style={label}>프로토콜</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select style={field} value={node.protocolId ?? ''} disabled={!canEdit} onChange={(e) => update({ protocolId: e.target.value, tcpMessage: '', tcpValues: {}, tcpResponseMessage: '', outputs: [] })}>
              <option value="">— 선택 —</option>
              {(protos.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <Link to={node.protocolId ? `/protocols/${node.protocolId}` : '/protocols'} style={{ fontSize: 11.5, whiteSpace: 'nowrap', color: 'var(--fl-primary)' }}>관리 →</Link>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}><label style={label}>타임아웃(ms)</label><input style={field} type="number" value={node.tcpTimeoutMs ?? 5000} readOnly={!canEdit} onChange={(e) => update({ tcpTimeoutMs: Number(e.target.value) })} /></div>
      </div>
      {spec && (
        <>
          <label style={label}>전문 (송신)</label>
          <select style={field} value={node.tcpMessage ?? ''} disabled={!canEdit} onChange={(e) => update({ tcpMessage: e.target.value, tcpValues: {} })}>
            <option value="">— 전문을 고르세요 —</option>
            {requestKeys(spec).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          {msg && (
            <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
              {headerRows.map(({ f, off }) => (
                <FieldRow key={'h-' + f.name} f={f} offset={off} value={values[f.name] ?? ''} encoding={spec.encoding} sources={sources} canEdit={canEdit} err={errFor(f.name)} onChange={(v) => setValue(f.name, v)} hint="헤더" />
              ))}
              {msg.fields.map((f, i) => (
                <FieldRow key={f.name} f={f} offset={offsets[i]} value={values[f.name] ?? ''} encoding={spec.encoding} sources={sources} canEdit={canEdit} err={errFor(f.name)} onChange={(v) => setValue(f.name, v)} />
              ))}
              <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>
                {spec.lengthField}·{spec.discriminator || '(분기 없음)'} 자동 · 헤더 {tableLen(spec.header)} + 본문 {tableLen(msg.fields)} = {tableLen(spec.header) + tableLen(msg.fields)} B
              </div>
            </div>
          )}
          {canEdit && (
            <div style={{ marginTop: 10, borderTop: '1px dashed var(--fl-border)', paddingTop: 10 }}>
              <button onClick={onPreview} style={singleBtn} title="전송 없이 조립해 바이트를 확인합니다(상류 바인딩은 빈 값)">🔍 전문 미리보기</button>
              {previewErr && <p style={{ fontSize: 11.5, color: 'var(--fl-fail)', marginTop: 6 }}>미리보기 실패: {previewErr}</p>}
              {preview && <PreviewBox p={preview} />}
            </div>
          )}
        </>
      )}
    </>
  )
}

/** 필드 한 줄 — 오프셋·타입/패딩·바이트 카운터 + 값(토큰 허용). 토큰이 섞이면 실제 길이는 실행 시에 정해지므로 카운터는 `?`. */
/** host:port 한 칸 — 저장 모델은 host/port 로 갈라져 있어 "host:" 중간 상태가 사라진다. 원문을 로컬로 들고 파싱해서 저장. */
function HostPortInput({ node, update, canEdit }: { node: GraphNode; update: Update; canEdit: boolean }) {
  const [text, setText] = useState(`${node.tcpHost ?? ''}${node.tcpPort ? ':' + node.tcpPort : ''}`)
  useEffect(() => { setText(`${node.tcpHost ?? ''}${node.tcpPort ? ':' + node.tcpPort : ''}`) }, [node.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input style={mono} aria-label="대상 host:port" value={text} placeholder="10.20.3.14:9600" readOnly={!canEdit}
      onChange={(e) => {
        const v = e.target.value
        setText(v)
        const t = v.trim(); const ci = t.lastIndexOf(':')
        if (ci > 0) {
          const digits = t.slice(ci + 1).replace(/[^0-9]/g, '')
          update({ tcpHost: t.slice(0, ci), tcpPort: digits ? Number(digits) : node.tcpPort }) // 포트 입력 중(빈 값)엔 기존 포트 유지
        } else update({ tcpHost: t })
      }} />
  )
}

export function FieldRow({ f, offset, value, encoding, sources, canEdit, err, onChange, hint }: { f: ProtocolField; offset: number; value: string; encoding: string; sources: BindableSource[]; canEdit: boolean; err?: string; onChange: (v: string) => void; hint?: string }) {
  const hasToken = value.includes('{{')
  const bytes = hasToken ? null : byteLen(value, encoding)
  const over = bytes != null && bytes > f.len
  const nonAscii = (f.type === 'ascii' || f.type === 'numeric') && !hasToken && [...value].some((c) => c.charCodeAt(0) > 0x7f)
  const nonDigit = f.type === 'numeric' && !hasToken && /[^0-9]/.test(value)
  const warn = err ?? (over ? `⚠ ${bytes}/${f.len} B 초과 — 전송 전 차단됩니다` : nonAscii ? '⚠ ascii 필드에 한글/비ASCII' : nonDigit ? '⚠ numeric 필드에 숫자 아닌 문자' : null)
  return (
    <div style={{ border: `1px solid ${warn ? 'var(--fl-fail)' : 'var(--fl-border)'}`, borderRadius: 'var(--fl-radius-sm)', padding: '6px 8px' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, fontSize: 11.5 }}>
        <span style={offBadge}>@{offset}</span>
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}{hint ? <span style={{ color: 'var(--fl-text-muted)', fontWeight: 400 }}> · {hint}</span> : null}</span>
        <span style={{ color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{f.type} {padOf(f)}</span>
        <span style={{ fontFamily: 'var(--fl-font-mono)', color: over ? 'var(--fl-fail)' : 'var(--fl-text-muted)' }}>{bytes ?? '?'}/{f.len} B</span>
      </div>
      {/* TokenInput 은 readOnly prop 이 없다 — 읽기 전용은 컨테이너에서 포인터/탭 차단 */}
      <div style={canEdit ? undefined : { pointerEvents: 'none', opacity: 0.7 }} aria-disabled={!canEdit}>
        <TokenInput ariaLabel={`필드 ${f.name}`} value={value} onChange={onChange} sources={sources} placeholder={f.type === 'binary' ? 'hex — 예: 0A FF' : '값 또는 { } 로 데이터 삽입'} />
      </div>
      {warn && <div style={{ fontSize: 11, color: 'var(--fl-fail)', marginTop: 3 }}>{warn}</div>}
    </div>
  )
}

/** 조립 결과(백엔드 계산) — 총 바이트·필드별 오프셋/길이·텍스트·HEX. */
export function PreviewBox({ p }: { p: ProtocolPreview }) {
  return (
    <div style={{ marginTop: 8, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', padding: 8 }}>
      {p.errors.length > 0 ? <div style={{ color: 'var(--fl-fail)', fontSize: 12 }}>{p.errors.map((e, i) => <div key={i}>{e.field ? `${e.field}: ` : ''}{e.message}</div>)}</div> : (
        <>
          <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 6, fontFamily: 'var(--fl-font-mono)' }}><b style={{ color: 'var(--fl-text)' }}>총 {p.total}B</b></div>
          <div style={{ display: 'grid', gap: 2, marginBottom: 6 }}>
            {p.fields.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, fontSize: 11, fontFamily: 'var(--fl-font-mono)' }}>
                <span style={offBadge}>@{f.offset}</span><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span><span style={{ color: 'var(--fl-text-muted)' }}>{f.actualBytes}/{f.len}B</span>{f.warn && <span style={{ color: 'var(--fl-fail)' }}>{f.warn}</span>}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fl-text-muted)' }}>텍스트</div>
          <pre style={pre}>{p.text}</pre>
          <details><summary style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fl-text-muted)', cursor: 'pointer' }}>HEX</summary><pre style={pre}>{p.hex}</pre></details>
        </>
      )}
    </div>
  )
}

export function TcpResponsePanel({ node, update, canEdit }: { node: GraphNode; update: Update; canEdit: boolean }) {
  const proto = useProtocol(node.protocolId || undefined)
  const spec = proto.data?.spec
  if (!spec) return <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>프로토콜을 먼저 고르세요.</p>
  const outs = outputsFor(spec, node.tcpResponseMessage || undefined)
  return (
    <>
      <label style={label}>응답 전문 (출력 키 기준)</label>
      <select style={field} value={node.tcpResponseMessage ?? ''} disabled={!canEdit} onChange={(e) => update({ tcpResponseMessage: e.target.value, outputs: outputsFor(spec, e.target.value || undefined) })}>
        <option value="">— 헤더 필드만 —</option>
        {messageKeys(spec).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        {outs.map((o) => <span key={o.key} style={chip}>{o.key}</span>)}
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>실행 시 실제 응답의 {spec.discriminator || '방향'}으로 표를 고릅니다. 정의되지 않은 전문이면 헤더 + <code>body</code>(raw) 로 출력됩니다.</p>
    </>
  )
}

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '10px 0 4px' }
const field: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const mono: CSSProperties = { ...field, fontFamily: 'var(--fl-font-mono)' }
const offBadge: CSSProperties = { flexShrink: 0, fontSize: 10, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderRadius: 4, padding: '2px 4px', minWidth: 26, textAlign: 'center' }
const singleBtn: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }
const pre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto', background: 'var(--fl-surface)' }
const chip: CSSProperties = { padding: '2px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)' }
