// frontend/src/components/TcpMockEditor.tsx — 프로토콜 참조형 TCP Mock 편집 조각(연결 · 규칙 · 전문 로그 · 보내보기).
// 전문 레이아웃은 여기서 정의하지 않는다 — 프로토콜(/protocols)이 소유하고 Mock 은 "그 규격을 쓰는 리스너"일 뿐.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { MockTcpCond, MockTcpFault, MockTcpRuleSpec, MockTcpSpec, ProtocolField, ProtocolSpec, TcpLogEntry, TcpSendResult } from '../api/types'
import { mocksApi, protocolsApi } from '../api/client'
import { TokenInput } from '../binding/TokenInput'
import { apiErrorMessage } from '../lib/apiError'
import { toast } from './toast'
import { relTime } from '../lib/format'
import { byteLen, lintTcpRules, requestKeys, withOffsets } from '../lib/protocolSpec'
import { tcpMockSources } from '../lib/mockSources'
import { FieldRow, PreviewBox } from '../panels/TcpNodePanel'

const COND_OPS: NonNullable<MockTcpCond['op']>[] = ['eq', 'ne', 'contains', 'startswith', 'endswith', 'regex', 'exists']
const OP_LABEL: Record<string, string> = { eq: '=', ne: '≠', contains: '⊃', startswith: '^', endswith: '$', regex: '~', exists: '있음' }

/** 규칙이 응답할 전문 키(분기 필드 값, 분기 없으면 'response'). */
export function responseKeyOf(rule: MockTcpRuleSpec, spec: ProtocolSpec | undefined): string {
  if (!spec?.discriminator) return 'response'
  return rule.then?.fields?.[spec.discriminator] ?? ''
}
/** 그 키의 응답 전문 정의 — `{key}:response` 우선(백엔드 lint/런타임과 같은 규약). */
export function responseMessageOf(rule: MockTcpRuleSpec, spec: ProtocolSpec | undefined) {
  const key = responseKeyOf(rule, spec)
  if (!spec || !key) return undefined
  return spec.messages.find((m) => m.key === `${key}:response`) ?? spec.messages.find((m) => m.key === key)
}

/**
 * 응답 전문 후보 — 분기 필드에 들어갈 값은 `0210` 이지 `0210:response` 가 아니다.
 * `{key}:response` 는 같은 코드의 응답 정의(responseMessageOf/lint 가 우선 해석)라 base key 로 합치고 라벨은 응답 쪽을 우선한다.
 */
export function responseKeyOptions(spec: ProtocolSpec): { key: string; label: string }[] {
  const m = new Map<string, string>()
  for (const msg of spec.messages) {
    const base = msg.key.split(':')[0]
    if (!m.has(base) || (msg.key.includes(':response') && msg.label)) m.set(base, msg.label ?? '')
  }
  return [...m].map(([key, label]) => ({ key, label: label ? `${key} · ${label}` : key }))
}

/** 좌 nav 한 줄 요약 — `거래코드=0210 · 응답코드≠0000 → mock 0211 ⚡delay 500`. */
export function tcpRuleSummary(rule: MockTcpRuleSpec, spec: ProtocolSpec | undefined): string {
  const conds = (rule.when ?? []).filter((c) => c.field?.trim())
  const when = conds.length ? conds.map((c) => `${c.field}${OP_LABEL[c.op ?? 'eq'] ?? c.op}${c.op === 'exists' ? '' : c.value ?? ''}`).join(' · ') : '조건 없음 (기본)'
  const then = rule.then?.mode === 'proxy' ? '→ proxy' : `→ mock ${responseKeyOf(rule, spec) || 'response'}`
  const f = rule.fault
  const fault = f ? [f.delayMs ? `delay ${f.delayMs}` : '', f.splitAt ? `split ${f.splitAt}` : '', f.drop ? 'drop' : '', f.reset ? 'reset' : '', f.corruptLength ? 'length 깨기' : ''].filter(Boolean).join(' ') : ''
  return `${when} ${then}${fault ? ` ⚡${fault}` : ''}`
}

// ---------- 연결 ----------

export function TcpConnPanel({ tcp, readOnly, onChange }: { tcp: MockTcpSpec; readOnly?: boolean; onChange: (patch: Partial<MockTcpSpec>) => void }) {
  const protos = useQuery({ queryKey: ['protocols'], queryFn: protocolsApi.list, staleTime: 15_000 })
  const addr = `${window.location.hostname || 'localhost'}:${tcp.port ?? 9091}`
  return (
    <section style={panel}>
      <h2 style={h2}>연결 <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>(포트 · 프로토콜 · 실서버)</span></h2>
      <p style={hint}>저장하면 백엔드가 이 포트에 리스너를 엽니다(모든 인터페이스 — 사내망 전제, 포트 충돌 시 저장 400). 전문 규격은 <b>프로토콜</b>이 소유합니다 — 여기서는 어떤 규격을 쓸지만 고릅니다.</p>
      {!tcp.protocolId && (
        <div style={warnBanner} role="note"><span>⚠</span><span>프로토콜을 골라야 리스너가 열립니다 — 전문을 어떻게 자르고 응답할지 알 수 없습니다.</span></div>
      )}
      <div style={{ display: 'grid', gap: 12, marginTop: 12, maxWidth: 620 }}>
        <div style={row}>
          <span style={{ ...lbl, minWidth: 96 }}>포트</span>
          <input style={{ ...input, width: 110, fontFamily: 'var(--fl-font-mono)' }} type="number" min={1024} max={65535} value={tcp.port ?? 9091} disabled={readOnly} aria-label="TCP 포트"
            onChange={(e) => onChange({ port: Number(e.target.value) || 0 })} />
          <span style={meta}>1024~65535 · 한 포트에 Mock 하나</span>
        </div>
        <div style={row}>
          <span style={{ ...lbl, minWidth: 96 }}>프로토콜</span>
          <select style={{ ...input, minWidth: 220 }} value={tcp.protocolId ?? ''} disabled={readOnly} aria-label="프로토콜"
            onChange={(e) => onChange({ protocolId: e.target.value || null })}>
            <option value="">— 선택 —</option>
            {(protos.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Link to={tcp.protocolId ? `/protocols/${tcp.protocolId}` : '/protocols'} style={linkStyle}>관리 →</Link>
        </div>
        <div style={row}>
          <span style={{ ...lbl, minWidth: 96 }}>실서버(upstream)</span>
          <input style={{ ...input, width: 220, fontFamily: 'var(--fl-font-mono)' }} value={tcp.upstream ?? ''} placeholder="10.20.3.14:9600" disabled={readOnly} aria-label="upstream host:port"
            onChange={(e) => onChange({ upstream: e.target.value.trim() || null })} />
          <span style={meta}>proxy 규칙이 넘길 실서버 — 비워 두면 mock 응답만</span>
        </div>
        <div style={row}>
          <span style={{ ...lbl, minWidth: 96 }}>타임아웃(ms)</span>
          <input style={{ ...input, width: 110, fontFamily: 'var(--fl-font-mono)' }} type="number" value={tcp.timeoutMs ?? 5000} disabled={readOnly} aria-label="타임아웃"
            onChange={(e) => onChange({ timeoutMs: Number(e.target.value) || 0 })} />
          <span style={meta}>proxy 응답 대기 상한</span>
        </div>
        <div style={row}>
          <span style={{ ...lbl, minWidth: 96 }}>리스닝 주소</span>
          <input readOnly value={addr} onFocus={(e) => e.currentTarget.select()} aria-label="리스닝 주소" style={{ ...input, width: 220, fontFamily: 'var(--fl-font-mono)' }} />
          <span style={meta}>워크플로 TCP 노드의 대상</span>
        </div>
      </div>
    </section>
  )
}

// ---------- 규칙 상세 ----------

export function TcpRuleDetail({ rule, index, total, spec, secrets, readOnly, onChange, onDelete, onDup, onMove }: {
  rule: MockTcpRuleSpec; index: number; total: number; spec: ProtocolSpec | undefined; secrets: string[]; readOnly?: boolean
  onChange: (patch: Partial<MockTcpRuleSpec>) => void; onDelete: () => void; onDup: () => void; onMove: (d: -1 | 1) => void
}) {
  const sources = useMemo(() => tcpMockSources(spec, secrets), [spec, secrets])
  // 이 규칙 하나만 린트 — upstream 은 연결 화면 책임이라 '-' 로 두고 필드 경고만 쓴다
  const lints = useMemo(() => (spec ? lintTcpRules({ upstream: '-', rules: [rule] }, spec).map((m) => m.replace(/^규칙 [^:]+: /, '')) : []), [rule, spec])
  const conds = rule.when ?? []
  const mode = rule.then?.mode ?? 'mock'
  const fields = rule.then?.fields ?? {}
  const respKey = responseKeyOf(rule, spec)
  const msg = responseMessageOf(rule, spec)
  const allNames = useMemo(() => (spec ? [...new Set([...spec.header, ...spec.messages.flatMap((m) => m.fields)].map((f) => f.name))] : []), [spec])
  const setCond = (i: number, patch: Partial<MockTcpCond>) => onChange({ when: conds.map((c, ci) => (ci === i ? { ...c, ...patch } : c)) })
  const setField = (name: string, v: string) => onChange({ then: { ...(rule.then ?? { mode: 'mock' }), mode, fields: { ...fields, [name]: v } } })
  const setMode = (m: 'mock' | 'proxy') => onChange({ then: { ...(rule.then ?? { mode: m }), mode: m } })
  const setRespKey = (key: string) => {
    if (!spec?.discriminator) return
    onChange({ then: { ...(rule.then ?? { mode: 'mock' }), mode: 'mock', fields: { ...fields, [spec.discriminator]: key } } })
  }
  const setFault = (patch: Partial<MockTcpFault>) => onChange({ fault: { ...(rule.fault ?? {}), ...patch } })
  // lintTcpRules 는 필드를 항상 `'이름'` 으로 인용한다 — 인용 없이 매칭하면 '금액' 이 '총금액' 경고를 가져온다
  const warnFor = (name: string) => lints.find((l) => l.includes(`'${name}'`))
  // 표에 그릴 행 — 헤더(length 제외) + 응답 본문 필드 + 정의에 없는데 값이 남아 있는 필드
  const headerRows = (spec?.header ?? []).filter((f) => f.type !== 'length')
  const known = new Set([...headerRows.map((f) => f.name), ...(msg?.fields ?? []).map((f) => f.name)])
  const orphans = Object.keys(fields).filter((k) => !known.has(k))
  const fault = rule.fault ?? {}
  const faultOn = !!(fault.delayMs || fault.splitAt || fault.drop || fault.reset || fault.corruptLength)

  return (
    <section style={panel}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={h2}>규칙 {index + 1}<span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}> / {total}</span></h2>
        <span style={{ ...meta, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tcpRuleSummary(rule, spec)}</span>
      </div>
      <p style={hint}>위에서부터 첫 매칭 — 조건은 모두 만족(AND)해야 합니다. 조건이 없으면 모든 전문에 이 규칙이 걸립니다(기본 규칙은 맨 아래로).</p>
      {!spec && <div style={warnBanner} role="note"><span>⚠</span><span>연결에서 프로토콜을 먼저 고르세요 — 필드 이름을 알 수 없어 조건·응답을 편집할 수 없습니다.</span></div>}

      {/* 조건 */}
      <div style={{ ...box, marginTop: 10 }}>
        <div style={boxTitle}>⬇ 조건 (AND)</div>
        <datalist id="tcp-fields">{allNames.map((n) => <option key={n} value={n} />)}</datalist>
        {conds.length === 0 && <div style={{ ...meta, marginTop: 6 }}>조건 없음 — 모든 전문에 매칭됩니다.</div>}
        {conds.map((c, i) => (
          <div key={i} style={{ ...row, marginTop: 6 }}>
            <span style={{ ...meta, minWidth: 34 }}>{i === 0 ? '조건' : 'AND'}</span>
            <input list="tcp-fields" style={{ ...input, width: 170, fontFamily: 'var(--fl-font-mono)' }} value={c.field ?? ''} placeholder="필드명 (예: 거래코드)" disabled={readOnly}
              aria-label={`조건 ${i + 1} 필드`} onChange={(e) => setCond(i, { field: e.target.value })} />
            <select style={{ ...input, width: 120 }} value={c.op ?? 'eq'} disabled={readOnly} aria-label={`조건 ${i + 1} 연산자`} onChange={(e) => setCond(i, { op: e.target.value as MockTcpCond['op'] })}>
              {COND_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input style={{ ...input, flex: 1, minWidth: 100, fontFamily: 'var(--fl-font-mono)' }} value={c.value ?? ''} placeholder="값" disabled={readOnly || c.op === 'exists'}
              aria-label={`조건 ${i + 1} 값`} onChange={(e) => setCond(i, { value: e.target.value })} />
            {!readOnly && <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => onChange({ when: conds.filter((_, ci) => ci !== i) })} aria-label={`조건 ${i + 1} 삭제`}>×</button>}
          </div>
        ))}
        {!readOnly && <button style={{ ...miniBtn, marginTop: 8 }} onClick={() => onChange({ when: [...conds, { field: spec?.discriminator || allNames[0] || '', op: 'eq', value: '' }] })}>+ 조건</button>}
      </div>

      {/* 어떻게 응답할까 */}
      <div style={{ ...box, marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={boxTitle}>⬆ 어떻게 응답할까</span>
          <div style={seg}>
            {(['mock', 'proxy'] as const).map((m) => (
              <button key={m} disabled={readOnly} onClick={() => setMode(m)} style={{ ...segBtn, background: mode === m ? 'var(--fl-primary)' : 'transparent', color: mode === m ? '#fff' : 'var(--fl-text-muted)' }}>
                {m === 'mock' ? 'Mock 응답' : '실서버로 통과(proxy)'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'proxy' ? (
          <p style={{ ...hint, marginTop: 8 }}>
            upstream <code style={code}>{'{연결에서 지정}'}</code> 로 그대로 전달하고 응답을 돌려줍니다 — 통과 전문도 로그에 <b>[proxy]</b> 로 보입니다.
          </p>
        ) : (
          <div style={{ marginTop: 8 }}>
            {spec?.discriminator ? (
              <div style={row}>
                <span style={{ ...lbl, minWidth: 70 }}>응답 전문</span>
                <select style={{ ...input, minWidth: 220 }} value={respKey} disabled={readOnly || !spec} aria-label="응답 전문" onChange={(e) => setRespKey(e.target.value)}>
                  <option value="">— 고르세요 —</option>
                  {(spec ? responseKeyOptions(spec) : []).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                </select>
                <span style={meta}>{spec.discriminator} = <code style={code}>{respKey || '(미지정)'}</code></span>
              </div>
            ) : (
              <div style={meta}>분기 필드가 없는 프로토콜 — 응답 전문은 <code style={code}>response</code> 고정입니다.</div>
            )}
            {spec && (msg || headerRows.length > 0) && (
              <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
                {headerRows.map((f) => <FieldValueRow key={`h-${f.name}`} f={f} kind="header" spec={spec} value={fields[f.name] ?? ''} disc={f.name === spec.discriminator} readOnly={readOnly} sources={sources} warn={warnFor(f.name)} onChange={(v) => setField(f.name, v)} />)}
                {(msg?.fields ?? []).map((f) => <FieldValueRow key={f.name} f={f} kind="body" spec={spec} value={fields[f.name] ?? ''} readOnly={readOnly} sources={sources} warn={warnFor(f.name)} onChange={(v) => setField(f.name, v)} />)}
                {orphans.map((k) => (
                  <div key={k} style={{ ...row, border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)', padding: '4px 8px' }}>
                    <span style={{ fontSize: 11.5, color: 'var(--fl-fail)', flex: 1 }}>⚠ <code style={code}>{k}</code> — 이 응답 전문에 없는 필드(다른 전문으로 바꾼 흔적)</span>
                    {!readOnly && <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => { const next = { ...fields }; delete next[k]; onChange({ then: { ...(rule.then ?? { mode: 'mock' }), mode, fields: next } }) }}>제거</button>}
                  </div>
                ))}
              </div>
            )}
            {spec && !msg && respKey && <div style={{ ...meta, color: 'var(--fl-fail)', marginTop: 6 }}>프로토콜에 <code style={code}>{respKey}</code> 전문 정의가 없습니다.</div>}
          </div>
        )}
      </div>

      {/* 장애 주입 */}
      <details style={{ ...box, marginTop: 10 }} open={faultOn}>
        <summary style={{ ...boxTitle, cursor: 'pointer' }}>⚡ 장애 주입 {faultOn && <span style={{ color: 'var(--fl-put, #f5a623)' }}>· 켜짐</span>}</summary>
        <p style={{ ...hint, marginTop: 6 }}>실제 버그는 대부분 여기서 난다 — 느린 응답·전문 쪼개짐·무응답·연결 끊김·길이 필드 불일치를 일부러 만들어 클라이언트를 시험합니다.</p>
        <div style={{ ...row, marginTop: 6 }}>
          <span style={{ ...lbl, minWidth: 70 }}>지연(ms)</span>
          <input style={{ ...input, width: 100, fontFamily: 'var(--fl-font-mono)' }} type="number" value={fault.delayMs ?? ''} placeholder="0" disabled={readOnly} aria-label="지연 ms"
            onChange={(e) => setFault({ delayMs: Number(e.target.value) || undefined })} />
          <span style={{ ...lbl, minWidth: 70 }}>쪼개기(byte)</span>
          <input style={{ ...input, width: 100, fontFamily: 'var(--fl-font-mono)' }} type="number" value={fault.splitAt ?? ''} placeholder="0" disabled={readOnly} aria-label="쪼개기 오프셋"
            onChange={(e) => setFault({ splitAt: Number(e.target.value) || null })} />
          <span style={meta}>N 바이트 보내고 끊어 보냅니다(부분 수신)</span>
        </div>
        <div style={{ ...row, marginTop: 6 }}>
          {([['drop', '무응답(drop)'], ['reset', '연결 끊기(reset)'], ['corruptLength', '길이 필드 깨기']] as const).map(([k, label]) => (
            <label key={k} style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!fault[k]} disabled={readOnly} onChange={(e) => setFault({ [k]: e.target.checked || undefined })} />{label}
            </label>
          ))}
        </div>
      </details>

      {!readOnly && (
        <div style={{ display: 'flex', gap: 6, marginTop: 12, justifyContent: 'flex-end', borderTop: '1px solid var(--fl-border)', paddingTop: 10 }}>
          <button style={miniBtn} onClick={() => onMove(-1)} disabled={index === 0} title="위로 (위에서부터 첫 매칭)">▲</button>
          <button style={miniBtn} onClick={() => onMove(1)} disabled={index === total - 1} title="아래로">▼</button>
          <button style={miniBtn} onClick={onDup}>복제</button>
          <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onDelete}>삭제</button>
        </div>
      )}
    </section>
  )
}

/** 응답 필드 한 줄 — 이름 · 타입/길이 · 값(TokenInput) · 경고. 분기 필드는 읽기 전용(응답 전문 select 가 정한다). */
function FieldValueRow({ f, kind, spec, value, disc, readOnly, sources, warn, onChange }: {
  f: ProtocolField; kind: 'header' | 'body'; spec: ProtocolSpec; value: string; disc?: boolean; readOnly?: boolean
  sources: ReturnType<typeof tcpMockSources>; warn?: string; onChange: (v: string) => void
}) {
  const bytes = value.includes('{{') ? null : byteLen(value, spec.encoding)
  return (
    <div style={{ ...row, border: `1px solid ${warn ? 'var(--fl-fail)' : 'var(--fl-border)'}`, borderRadius: 'var(--fl-radius-sm)', padding: '5px 8px', alignItems: 'center' }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</span>
      <span style={{ ...meta, width: 92 }}>{f.type} {f.len}B{bytes != null ? ` · ${bytes}` : ''}</span>
      {disc ? (
        <code style={{ ...code, flex: 1 }}>{value || '(응답 전문 미선택)'}</code>
      ) : (
        <div style={{ flex: 1, minWidth: 160, ...(readOnly ? { pointerEvents: 'none', opacity: 0.7 } : null) }} aria-disabled={readOnly}>
          <TokenInput ariaLabel={`${f.name} 값`} value={value} sources={sources} placeholder={kind === 'header' ? '비우면 요청 에코' : '비우면 빈 값(패딩)'} onChange={onChange} />
        </div>
      )}
      {warn && <span style={{ fontSize: 11, color: 'var(--fl-fail)', maxWidth: 220 }}>{warn}</span>}
    </div>
  )
}

// ---------- 전문 로그 ----------

/** 폴링으로 목록이 갈리므로 펼침 상태는 인덱스가 아니라 행 내용으로 식별한다(같은 키가 행 key 이기도 하다). */
const rowKey = (e: TcpLogEntry): string => `${e.at}|${e.dir}|${e.bytes}|${e.hex || e.text}`
/** 완전히 같은 전문이 같은 ms 에 두 번 찍혔을 때만 인덱스를 덧붙인다(최후 수단). */
const rowKeys = (rows: TcpLogEntry[]): string[] => {
  const seen = new Set<string>()
  return rows.map((e, i) => { const k = rowKey(e); if (seen.has(k)) return `${k}#${i}`; seen.add(k); return k })
}

export function TcpLogPanel({ mockId, protocolId, canEdit, onMakeRule }: { mockId: string; protocolId: string | null | undefined; canEdit?: boolean; onMakeRule?: (e: TcpLogEntry) => void }) {
  const qc = useQueryClient()
  const log = useQuery({ queryKey: ['mock-tcp-log', mockId], queryFn: () => mocksApi.tcpLog(mockId), enabled: !!mockId, refetchInterval: 3000, retry: false })
  const clear = useMutation({
    mutationFn: () => mocksApi.clearTcpLog(mockId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mock-tcp-log', mockId] }),
    onError: (e) => toast(apiErrorMessage(e, '로그 지우기 실패'), 'error'),
  })
  const [filter, setFilter] = useState<'all' | 'mock' | 'proxy' | 'warn'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const rows = (log.data ?? []).filter((e) => (filter === 'all' ? true : filter === 'warn' ? e.level !== 'info' : e.source === filter))
  const keys = rowKeys(rows)
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '4px 12px' }}>
        <div style={seg}>
          {([['all', '전체'], ['mock', 'mock'], ['proxy', 'proxy'], ['warn', '⚠']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} style={{ ...segBtn, background: filter === k ? 'var(--fl-primary)' : 'transparent', color: filter === k ? '#fff' : 'var(--fl-text-muted)' }}>{label}</button>
          ))}
        </div>
        <span style={meta}>{rows.length}건</span>
        <span style={{ marginLeft: 'auto' }} />
        {canEdit && (log.data?.length ?? 0) > 0 && <button style={{ ...miniBtn, padding: '3px 8px' }} disabled={clear.isPending} onClick={() => clear.mutate()}>지우기</button>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 10px' }}>
        {rows.length === 0 ? (
          <div style={{ ...meta, padding: '8px 0' }}>{log.data?.length ? '필터에 맞는 전문이 없습니다.' : '아직 전문이 없습니다 — 워크플로 TCP 노드나 아래 [보내보기]로 이 포트에 전문을 보내면 여기에 쌓입니다.'}</div>
        ) : (
          <div style={{ display: 'grid', gap: 3 }}>{rows.map((e, i) => { const k = keys[i]; return <LogRow key={k} e={e} open={open === k} protocolId={protocolId} onToggle={() => setOpen(open === k ? null : k)} onMakeRule={onMakeRule} /> })}</div>
        )}
      </div>
    </div>
  )
}

function LogRow({ e, open, protocolId, onToggle, onMakeRule }: { e: TcpLogEntry; open: boolean; protocolId: string | null | undefined; onToggle: () => void; onMakeRule?: (e: TcpLogEntry) => void }) {
  const srcColor = e.source === 'mock' ? 'var(--fl-ok)' : e.source === 'proxy' ? 'var(--fl-primary)' : 'var(--fl-text-muted)'
  const bg = e.level === 'error' ? 'color-mix(in srgb, var(--fl-fail) 12%, var(--fl-surface))' : e.level === 'warn' ? 'color-mix(in srgb, var(--fl-put, #f5a623) 12%, var(--fl-surface))' : 'transparent'
  const entries = Object.entries(e.fields ?? {})
  const summary = entries.slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' · ') + (entries.length > 6 ? ` +${entries.length - 6}` : '')
  const parts = e.chunks ?? []
  const undefinedMsg = e.dir === 'in' && !!e.note?.includes('본문 스키마 없음')
  return (
    <div style={{ border: '1px solid var(--fl-border)', borderRadius: 6, overflow: 'hidden', background: bg }}>
      <button onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 10px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--fl-text)' }}>
        <span style={{ ...meta, minWidth: 74 }}>{hhmmss(e.at)}</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: e.dir === 'in' ? 'var(--fl-text)' : 'var(--fl-text-muted)' }} title={e.dir === 'in' ? '수신' : '송신'}>{e.dir === 'in' ? '→' : '←'}</span>
        <span style={{ ...tag, color: srcColor, borderColor: srcColor }}>[{e.source}]</span>
        <b style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, minWidth: 44 }}>{e.key ?? '—'}</b>
        <span style={{ ...meta, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={summary}>{summary}</span>
        {e.partial && <span style={{ ...tag, color: 'var(--fl-put, #f5a623)', borderColor: 'var(--fl-put, #f5a623)' }} title="한 전문이 여러 번에 나눠 도착">부분 수신{parts.length ? ` ${parts.join('+')}` : ''}</span>}
        <span style={meta}>{e.bytes} B</span>
        <span style={meta}>{relTime(e.at)}</span>
      </button>
      {e.note && <div style={{ padding: '0 10px 5px 92px', fontSize: 11, color: e.level === 'error' ? 'var(--fl-fail)' : e.level === 'warn' ? 'var(--fl-put, #f5a623)' : 'var(--fl-text-muted)' }}>{e.note}</div>}
      {open && (
        <div style={{ padding: '0 10px 8px', display: 'grid', gap: 5 }}>
          <pre style={pre}>{e.text}</pre>
          <details><summary style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fl-text-muted)', cursor: 'pointer' }}>HEX</summary><pre style={pre}>{e.hex}</pre></details>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {e.dir === 'in' && onMakeRule && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => onMakeRule(e)} title="이 전문에 맞는 규칙 초안(전문 코드 eq 조건)">규칙 초안</button>}
            {undefinedMsg && protocolId && <Link to={`/protocols/${protocolId}?add=${encodeURIComponent(e.key ?? '')}`} style={linkStyle}>→ 이 코드로 본문 정의 만들기</Link>}
          </div>
        </div>
      )}
    </div>
  )
}

const hhmmss = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(Math.floor(d.getMilliseconds() / 100))}`
}

// ---------- 보내보기 ----------

export function TcpSendPanel({ mockId, spec, ensureSaved }: { mockId: string; spec: ProtocolSpec | undefined; ensureSaved: () => Promise<boolean> }) {
  const qc = useQueryClient()
  const keys = spec ? requestKeys(spec) : []
  const [key, setKey] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<TcpSendResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const sel = key || keys[0]?.key || ''
  const msg = spec?.messages.find((m) => m.key === sel)
  const offsets = spec && msg ? withOffsets(spec.header, msg.fields) : []
  const headerRows = spec ? withOffsets([], spec.header).map((off, i) => ({ f: spec.header[i], off })).filter(({ f }) => f.type !== 'length' && f.name !== spec.discriminator) : []
  const send = useMutation({
    mutationFn: async () => {
      if (!(await ensureSaved())) throw new Error('미저장 편집이 있습니다 — 먼저 저장하세요.')
      return mocksApi.tcpSend(mockId, { key: sel, values })
    },
    onSuccess: (r) => { setResult(r); setErr(null); void qc.invalidateQueries({ queryKey: ['mock-tcp-log', mockId] }) },
    onError: (e) => { setResult(null); setErr(apiErrorMessage(e, '전송 실패')) },
  })
  if (!spec) return <div style={{ ...meta, padding: 12 }}>연결에서 프로토콜을 먼저 고르세요.</div>
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px 10px', display: 'grid', gap: 10, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={row}>
          <select style={{ ...input, flex: 1 }} value={sel} aria-label="보낼 전문" onChange={(e) => { setKey(e.target.value); setValues({}); setResult(null) }}>
            {keys.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <button style={primaryBtn} disabled={!sel || send.isPending} onClick={() => send.mutate()}>▶ 보내기</button>
        </div>
        {err && <div style={{ fontSize: 12, color: 'var(--fl-fail)' }}>{err}</div>}
        <div style={meta}>값은 템플릿 없이 그대로 전송됩니다.</div>
        {headerRows.map(({ f, off }) => (
          <FieldRow key={`h-${f.name}`} f={f} offset={off} value={values[f.name] ?? ''} encoding={spec.encoding} sources={[]} canEdit hint="헤더" onChange={(v) => setValues({ ...values, [f.name]: v })} />
        ))}
        {(msg?.fields ?? []).map((f, i) => (
          <FieldRow key={f.name} f={f} offset={offsets[i]} value={values[f.name] ?? ''} encoding={spec.encoding} sources={[]} canEdit onChange={(v) => setValues({ ...values, [f.name]: v })} />
        ))}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ ...boxTitle, display: 'flex', gap: 8, alignItems: 'center' }}>
          응답
          {result && <><code style={code}>{result.response.key ?? '(디코딩 실패)'}</code><span style={meta}>{result.elapsedMs}ms · {result.response.bytes}B{result.response.partial ? ` · 부분 수신 ${result.response.chunks.join('+')}` : ''}</span></>}
        </div>
        {!result ? <div style={{ ...meta, border: '1px dashed var(--fl-border)', borderRadius: 6, padding: 12 }}>전문을 보내면 요청 조립 결과와 응답이 여기에 표시됩니다.</div> : (
          <>
            {result.response.warnings.map((w, i) => <div key={i} style={{ fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }}>⚠ {w}</div>)}
            <FieldTableView title="헤더" rows={result.response.header} />
            {result.response.body ? <FieldTableView title="본문" rows={result.response.body} /> : <div style={meta}>본문 스키마 없음 — 아래 원문으로 확인하세요.</div>}
            <pre style={pre}>{result.response.text}</pre>
            <details><summary style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fl-text-muted)', cursor: 'pointer' }}>HEX</summary><pre style={pre}>{result.response.hex}</pre></details>
            <details><summary style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--fl-text-muted)', cursor: 'pointer' }}>보낸 요청</summary><PreviewBox p={result.request} /></details>
          </>
        )}
      </div>
    </div>
  )
}

function FieldTableView({ title, rows }: { title: string; rows: Record<string, string> }) {
  const entries = Object.entries(rows ?? {})
  if (!entries.length) return null
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--fl-text-muted)', marginBottom: 2 }}>{title}</div>
      <div style={{ display: 'grid', gap: 1 }}>
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', gap: 8, fontSize: 11.5, fontFamily: 'var(--fl-font-mono)' }}>
            <span style={{ width: 130, color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- 스타일 ----------

const panel: CSSProperties = { padding: 18, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const h2: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const meta: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const input: CSSProperties = { padding: '6px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const primaryBtn: CSSProperties = { padding: '6px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const lbl: CSSProperties = { fontSize: 12, fontWeight: 700 }
const box: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface-2)' }
const boxTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700 }
const row: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const seg: CSSProperties = { display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }
const segBtn: CSSProperties = { padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }
const tag: CSSProperties = { fontSize: 10, fontWeight: 700, fontFamily: 'var(--fl-font-mono)', border: '1px solid', borderRadius: 4, padding: '0 4px' }
const pre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto' }
const linkStyle: CSSProperties = { fontSize: 11.5, whiteSpace: 'nowrap', color: 'var(--fl-primary)' }
const warnBanner: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginTop: 10, border: '1px solid color-mix(in srgb, var(--fl-put, #f5a623) 60%, var(--fl-border))', background: 'color-mix(in srgb, var(--fl-put, #f5a623) 10%, var(--fl-surface))', borderRadius: 'var(--fl-radius-sm)', fontSize: 12.5 }
