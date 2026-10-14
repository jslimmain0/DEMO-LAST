import { useState, type CSSProperties, type ReactNode } from 'react'
import type { CodecInfo, ProtocolAck, ProtocolFraming, ProtocolSpec, ProtocolTransaction } from '../api/types'
import { framingOf, tableLen } from '../lib/protocolSpec'
import { FieldTable } from './ProtocolFieldTable'
import { ui } from '../design/ui'

export function ProtocolTransactionsEditor({ spec, patch, readOnly, codecs, frameEditor }: {
  spec: ProtocolSpec; patch: (value: Partial<ProtocolSpec>) => void; readOnly: boolean; codecs: CodecInfo[]
  frameEditor: (label: string, frame: ProtocolFraming, onChange: (value: ProtocolFraming) => void) => ReactNode
}) {
  const [selected, select] = useState(0)
  const [ackSelected, selectAck] = useState(0)
  const transactions = spec.transactions ?? [], layouts = spec.ackMessages ?? []
  const transaction = transactions[selected], layout = layouts[ackSelected]
  const enabled = spec.schemaVersion === 2
  const hasDefinitions = transactions.length > 0 || layouts.length > 0
  const update = (value: Partial<ProtocolTransaction>) => patch({ transactions: transactions.map((row, index) => index === selected ? { ...row, ...value } : row) })
  const unique = (prefix: string, keys: string[]) => { let index = 1; while (keys.includes(`${prefix}-${index}`)) index++; return `${prefix}-${index}` }
  return <section style={section} aria-label="거래별 전송과 ACK">
    <h3 style={heading}>거래별 전송과 ACK</h3>
    <label style={row}><input type="checkbox" aria-label="거래별 설정 사용" checked={enabled} disabled={readOnly || (enabled && hasDefinitions)} onChange={e => patch(e.target.checked ? { schemaVersion: 2, transactions: spec.transactions ?? [], ackMessages: spec.ackMessages ?? [] } : { schemaVersion: undefined, transactions: undefined, ackMessages: undefined })} /><b>거래별 설정 사용 (v2)</b></label>
    <p style={hint}>{enabled ? '같은 포트에서 공통 헤더의 조건으로 거래를 고른 뒤 그 거래의 길이·ACK를 적용합니다. 기존 규격과 필드는 그대로 유지됩니다.' : '기존 규격은 자동으로 바꾸지 않습니다. 거래마다 길이 또는 ACK가 다른 경우 직접 사용을 선택하세요.'}</p>
    {enabled && hasDefinitions && <p style={hint}>v1로 돌아가려면 거래와 ACK 레이아웃을 먼저 삭제하세요. 기존 고정 ACK는 거래별 ACK와 함께 사용할 수 없습니다.</p>}
    {enabled && <>
      <div style={{ ...row, marginBottom: 12 }}>
        {transactions.map((entry, index) => <button key={index} style={index === selected ? ui.primary : ui.secondary} aria-pressed={index === selected} onClick={() => select(index)}>{entry.key || `거래 ${index + 1}`}</button>)}
        {!readOnly && <button style={ui.secondary} onClick={() => { patch({ transactions: [...transactions, { key: unique('transaction', transactions.map(t => t.key)), when: [], requestMessage: '', responseMessage: '', framing: { ...framingOf(spec) }, responseFraming: { ...framingOf(spec, true) }, requestAck: null, responseAck: null }] }); select(transactions.length) }}>+ 거래 추가</button>}
      </div>
      {!transaction ? <p style={hint}>거래를 추가한 다음 헤더 조건과 요청·응답 전문을 지정하세요. 길이나 성공 코드는 추측해서 채우지 않습니다.</p> : <div style={{ display: 'grid', gap: 12 }}>
        <label style={row}>거래 키<input aria-label="거래 키" value={transaction.key} readOnly={readOnly} onChange={e => update({ key: e.target.value })} style={input} /></label>
        <fieldset style={box}><legend>거래 선택 · 헤더 조건 모두 일치 (AND)</legend>
          <p style={hint}>본문을 읽기 전에 선택합니다. 헤더에 없는 필드나 같은 조건의 거래는 사용할 수 없습니다.</p>
          {transaction.when.map((condition, index) => <div key={index} style={row}>
            <select aria-label={`거래 조건 ${index + 1} 헤더`} disabled={readOnly} value={condition.field} style={input} onChange={e => update({ when: transaction.when.map((value, i) => i === index ? { ...value, field: e.target.value } : value) })}><option value="">헤더 필드 선택</option>{spec.header.map(field => <option key={field.name} value={field.name}>{field.name}</option>)}</select>
            <span>=</span><input aria-label={`거래 조건 ${index + 1} 값`} readOnly={readOnly} value={condition.value} style={input} onChange={e => update({ when: transaction.when.map((value, i) => i === index ? { ...value, value: e.target.value } : value) })} />
            {!readOnly && <button aria-label={`거래 조건 ${index + 1} 삭제`} style={ui.mini} onClick={() => update({ when: transaction.when.filter((_, i) => i !== index) })}>삭제</button>}
          </div>)}
          {!readOnly && <button style={ui.mini} onClick={() => update({ when: [...transaction.when, { field: '', op: 'eq', value: '' }] })}>+ 헤더 조건</button>}
        </fieldset>
        <div style={row}>{(['requestMessage', 'responseMessage'] as const).map((key, index) => <label key={key} style={row}>{index === 0 ? '요청 전문' : '응답 전문'}<select aria-label={`거래 ${index === 0 ? '요청' : '응답'} 전문`} value={transaction[key]} disabled={readOnly} onChange={e => update({ [key]: e.target.value })} style={input}><option value="">전문 선택</option>{spec.messages.map(message => <option key={message.key} value={message.key}>{message.key} · {message.label || ''}</option>)}</select></label>)}</div>
        {(['framing', 'responseFraming'] as const).map((key, index) => <div key={key}>
          <label style={row}><input type="checkbox" checked={!transaction[key]} disabled={readOnly} onChange={e => update({ [key]: e.target.checked ? undefined : { ...framingOf(spec, index === 1) } })} />{index === 0 ? '요청' : '응답'}은 공통 경계 사용</label>
          {transaction[key] && frameEditor(`거래 ${index === 0 ? '요청' : '응답'}`, transaction[key]!, value => update({ [key]: value }))}
        </div>)}
        {(['requestAck', 'responseAck'] as const).map(key => <AckEditor key={key} label={key === 'requestAck' ? '요청 ACK' : '응답 ACK'} value={transaction[key]} spec={spec} readOnly={readOnly} onChange={value => update({ [key]: value })} />)}
        {!readOnly && <button style={{ ...ui.secondary, justifySelf: 'start' }} onClick={() => { patch({ transactions: transactions.filter((_, index) => index !== selected) }); select(Math.max(0, selected - 1)) }}>선택 거래 삭제</button>}
      </div>}
      <div style={{ borderTop: '1px solid var(--fl-border)', marginTop: 20, paddingTop: 16 }}>
        <h4 style={heading}>독립 ACK 레이아웃</h4>
        <p style={hint}>업무 헤더를 붙이지 않습니다. ACK 자체의 필드만 정의하세요. 길이는 최대 1,024 B입니다.</p>
        <div style={row}>{layouts.map((entry, index) => <button key={index} style={index === ackSelected ? ui.primary : ui.secondary} aria-pressed={index === ackSelected} onClick={() => selectAck(index)}>{entry.key || `ACK ${index + 1}`}</button>)}
          {!readOnly && <button style={ui.secondary} onClick={() => { patch({ ackMessages: [...layouts, { key: unique('ack', layouts.map(a => a.key)), encoding: spec.encoding, fields: [] }] }); selectAck(layouts.length) }}>+ ACK 레이아웃</button>}
        </div>
        {layout && <div style={{ marginTop: 12 }}>
          <div style={row}><label style={row}>ACK 키<input aria-label="ACK 레이아웃 키" style={input} value={layout.key} readOnly={readOnly} onChange={e => patch({ ackMessages: layouts.map((entry, index) => index === ackSelected ? { ...entry, key: e.target.value } : entry) })} /></label>
            <label style={row}>인코딩<select aria-label="ACK 인코딩" style={input} value={layout.encoding ?? ''} disabled={readOnly} onChange={e => patch({ ackMessages: layouts.map((entry, index) => index === ackSelected ? { ...entry, encoding: e.target.value || undefined } : entry) })}><option value="">프로토콜 기본값</option>{['UTF-8', 'EUC-KR', 'MS949', 'US-ASCII'].map(encoding => <option key={encoding}>{encoding}</option>)}</select></label><b>{tableLen(layout.fields)} B</b>
          </div>
          <FieldTable key={ackSelected} fields={layout.fields} onChange={fields => patch({ ackMessages: layouts.map((entry, index) => index === ackSelected ? { ...entry, fields } : entry) })} baseOffset={0} codecs={codecs} readOnly={readOnly} />
          {!readOnly && <button style={{ ...ui.mini, marginTop: 10 }} onClick={() => { patch({ ackMessages: layouts.filter((_, index) => index !== ackSelected) }); selectAck(Math.max(0, ackSelected - 1)) }}>선택 ACK 레이아웃 삭제</button>}
        </div>}
      </div>
    </>}
  </section>
}

function AckEditor({ label, value, spec, readOnly, onChange }: { label: string; value: ProtocolAck | null; spec: ProtocolSpec; readOnly: boolean; onChange: (value: ProtocolAck | null) => void }) {
  const layouts = spec.ackMessages ?? []
  const layoutOptions = <><option value="">ACK 레이아웃 선택</option>{layouts.map(layout => <option key={layout.key} value={layout.key}>{layout.key} · {tableLen(layout.fields)} B</option>)}</>
  return <fieldset style={box}><legend>{label}</legend>
    <label style={row}><input type="checkbox" aria-label={`${label} 사용`} checked={!!value} disabled={readOnly} onChange={e => onChange(e.target.checked ? { send: { kind: 'hex', hex: '' }, receive: { kind: 'length-only' }, timeoutMs: 3000 } : null)} />이 단계 사용</label>
    <p style={hint}>{label === '요청 ACK' ? 'Mock은 송신 정의로 보내고, 클라이언트는 수신 정의로 확인합니다. 요청(req)만 참조할 수 있습니다.' : '클라이언트는 송신 정의로 보내고, Mock은 수신 정의로 확인합니다. 요청(req)·응답(res)을 참조할 수 있습니다.'}</p>
    {value && <div style={{ display: 'grid', gap: 10 }}>
      <label style={row}>제한 시간(ms)<input aria-label={`${label} 제한 시간`} type="number" min={1} max={120000} style={input} value={value.timeoutMs ?? ''} readOnly={readOnly} onChange={e => onChange({ ...value, timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
      <label style={row}>송신 방식<select aria-label={`${label} 송신 방식`} style={input} value={value.send.kind} disabled={readOnly} onChange={e => onChange({ ...value, send: e.target.value === 'hex' ? { kind: 'hex', hex: value.send.hex ?? '' } : { kind: 'message', messageKey: value.send.messageKey ?? '', values: value.send.values ?? {} } })}><option value="hex">고정 HEX</option><option value="message">ACK 레이아웃 조립</option></select></label>
      {value.send.kind === 'hex' ? <input aria-label={`${label} 송신 HEX`} style={input} placeholder="정해진 HEX를 입력하세요" value={value.send.hex ?? ''} readOnly={readOnly} onChange={e => onChange({ ...value, send: { ...value.send, hex: e.target.value } })} /> : <>
        <select aria-label={`${label} 송신 레이아웃`} style={input} value={value.send.messageKey ?? ''} disabled={readOnly} onChange={e => onChange({ ...value, send: { ...value.send, messageKey: e.target.value } })}>{layoutOptions}</select>
        <AckValues label={`${label} 송신 값`} names={layouts.find(layout => layout.key === value.send.messageKey)?.fields.map(field => field.name) ?? []} values={value.send.values ?? {}} readOnly={readOnly} onChange={values => onChange({ ...value, send: { ...value.send, values } })} />
      </>}
      <label style={row}>수신 확인<select aria-label={`${label} 수신 확인`} style={input} value={value.receive.kind} disabled={readOnly} onChange={e => onChange({ ...value, receive: e.target.value === 'exact' ? { kind: 'exact', hex: value.receive.hex ?? '' } : e.target.value === 'fields' ? { kind: 'fields', messageKey: value.receive.messageKey ?? '', expected: value.receive.expected ?? {} } : { kind: 'length-only', lengthBytes: value.receive.lengthBytes } })}><option value="length-only">길이만 수신 · 내용 비교 안 함</option><option value="exact">고정 HEX 일치</option><option value="fields">ACK 필드 비교</option></select></label>
      {value.receive.kind === 'length-only' && <><input aria-label={`${label} 수신 길이`} type="number" min={1} max={1024} style={input} value={value.receive.lengthBytes ?? ''} readOnly={readOnly} placeholder="규격에 정해진 바이트 수" onChange={e => onChange({ ...value, receive: { ...value.receive, lengthBytes: e.target.value === '' ? undefined : Number(e.target.value) } })} /><p style={hint}>성공 응답 시험에 사용할 수 있습니다. 내용은 비교하지 않지만 길이 부족·시간 초과·연결 종료는 실패입니다.</p></>}
      {value.receive.kind === 'exact' && <input aria-label={`${label} 수신 HEX`} style={input} value={value.receive.hex ?? ''} readOnly={readOnly} onChange={e => onChange({ ...value, receive: { ...value.receive, hex: e.target.value } })} />}
      {value.receive.kind === 'fields' && <>
        <select aria-label={`${label} 수신 레이아웃`} style={input} value={value.receive.messageKey ?? ''} disabled={readOnly} onChange={e => onChange({ ...value, receive: { ...value.receive, messageKey: e.target.value } })}>{layoutOptions}</select>
        <AckValues label={`${label} 비교 값`} names={layouts.find(layout => layout.key === value.receive.messageKey)?.fields.map(field => field.name) ?? []} values={value.receive.expected ?? {}} readOnly={readOnly} onChange={expected => onChange({ ...value, receive: { ...value.receive, expected } })} />
      </>}
      <p style={hint}>송신 길이와 수신 길이는 같아야 합니다. 방식을 바꾸면 이전 방식의 전용 입력을 교체합니다. 정밀 검증에는 HEX 일치나 필드 비교를 선택하세요. 이 화면에서 저장하거나 전송하지 않습니다.</p>
    </div>}
  </fieldset>
}

function AckValues({ label, names, values, readOnly, onChange }: { label: string; names: string[]; values: Record<string, string>; readOnly: boolean; onChange: (values: Record<string, string>) => void }) {
  return <div style={{ display: 'grid', gap: 6 }}><p style={hint}>{label} · 상수 또는 {'{{req.필드}} / {{res.필드}}'}. 체크한 필드만 포함하며 빈 문자열도 명시적으로 지정할 수 있습니다.</p>
    {[...new Set([...names, ...Object.keys(values)])].map(name => <div key={name} style={row}>
      <label style={row}><input aria-label={`${label} ${name} 포함`} type="checkbox" checked={Object.hasOwn(values, name)} disabled={readOnly} onChange={e => { const next = { ...values }; if (e.target.checked) next[name] = ''; else delete next[name]; onChange(next) }} />{name}{!names.includes(name) && ' · 레이아웃에 없음'}</label>
      <input aria-label={`${label} ${name}`} style={{ ...input, flex: '1 1 180px' }} value={values[name] ?? ''} disabled={!Object.hasOwn(values, name)} readOnly={readOnly} onChange={e => onChange({ ...values, [name]: e.target.value })} />
    </div>)}
  </div>
}
const section: CSSProperties = { padding: 16, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', minWidth: 0 }
const heading: CSSProperties = { margin: '0 0 12px', fontSize: 15 }
const box: CSSProperties = { margin: 0, padding: 12, minWidth: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', fontSize: 13 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6, fontSize: 13, minWidth: 0 }
const input: CSSProperties = { padding: '7px 9px', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', font: 'inherit', fontSize: 13 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.7, overflowWrap: 'anywhere', margin: '6px 0 10px' }
