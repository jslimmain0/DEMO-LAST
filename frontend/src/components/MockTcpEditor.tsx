import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { MockCodecSpec, MockTcpCond, MockTcpPreview, MockTcpReqField, MockTcpRespField, MockTcpRuleSpec, MockTcpSpec } from '../api/types'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { mocksApi } from '../api/client'
import { apiErrorMessage } from '../lib/apiError'
import { newId } from '../lib/ids'

const ENCODINGS = ['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII']
const COND_OPS: NonNullable<MockTcpCond['op']>[] = ['eq', 'ne', 'contains', 'startswith', 'endswith', 'regex', 'exists']

/**
 * TCP 전문 mock 편집 — 텍스트 한 줄 대신 **항목별 바이트 길이·패딩**으로 전문을 정의한다(한글 2바이트 등은 백엔드가 계산).
 * - 요청 레이아웃: 들어온 전문을 앞에서부터 길이대로 잘라 필드명을 붙임 → 규칙 조건·{{req.이름}} 토큰.
 * - 규칙 응답: [필드] 모드(길이·값·패딩·인코딩, 바이트 조립) 또는 [텍스트] 템플릿.
 * - 미리보기: 샘플 요청으로 요청 분해·매칭 규칙·응답 hex/필드 오프셋/절단·패딩을 저장 없이 확인.
 */
export function MockTcpEditor({ tcp, onChange, readOnly, codec, environment, sources = [] }: { tcp: MockTcpSpec | null; onChange: (t: MockTcpSpec | null) => void; readOnly?: boolean; codec?: MockCodecSpec | null; environment?: string | null; sources?: BindableSource[] }) {
  const on = !!tcp
  const t = tcp ?? {}
  const set = (patch: Partial<MockTcpSpec>) => onChange({ ...t, ...patch })
  const rules = t.rules ?? []
  const layout = t.requestFields ?? []
  const setRule = (i: number, patch: Partial<MockTcpRuleSpec>) => set({ rules: rules.map((r, ri) => (ri === i ? { ...r, ...patch } : r)) })
  const move = <T,>(arr: T[], i: number, d: -1 | 1): T[] => { const j = i + d; if (j < 0 || j >= arr.length) return arr; const n = [...arr]; const x = n[i]; n[i] = n[j]; n[j] = x; return n }

  const defaultTcp = (): MockTcpSpec => ({
    enabled: true, port: t.port ?? 9091, charset: t.charset ?? 'EUC-KR', prefixLength: t.prefixLength ?? 4, prefixIncludesSelf: t.prefixIncludesSelf ?? false,
    requestFields: layout.length ? layout : [{ id: newId(), name: '전문코드', length: 4 }, { id: newId(), name: '계좌번호', length: 10 }],
    rules: rules.length ? rules : [{ id: newId(), contains: '', when: [], response: '', responseFields: [
      { id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' },
      { id: newId(), name: '계좌번호', length: 10, value: '{{req.계좌번호}}', pad: 'right', padChar: ' ' },
      { id: newId(), name: '잔액', length: 12, value: '1500000', pad: 'left', padChar: '0' },
      { id: newId(), name: '고객명', length: 10, value: '홍길동', pad: 'right', padChar: ' ' },
    ] }],
  })

  return (
    <section style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={h2}>TCP 전문 mock</h2>
        <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={on} disabled={readOnly} onChange={(e) => onChange(e.target.checked ? defaultTcp() : null)} />
          사용 — 저장하면 지정 포트에 TCP 리스너가 열립니다
        </label>
      </div>
      <p style={hint}>
        고정길이 전문(길이 프리픽스) 대상 시스템을 흉내냅니다 — 워크플로의 <b>TCP 전문</b> 노드가 여기로 붙습니다.
        길이는 전부 <b>바이트</b>(EUC-KR 한글 2바이트) — 항목별로 길이·패딩을 정하면 백엔드가 바이트 단위로 정확히 조립합니다.
        값 템플릿: <code style={code}>{'{{req.필드명}}'}</code> 요청 필드 · <code style={code}>{'{{req}}'}</code> 전체 · <code style={code}>{'{{req:오프셋:길이}}'}</code> 슬라이스 · <code style={code}>{'{{seq}}'}</code> <code style={code}>{'{{now}}'}</code> <code style={code}>{'{{uuid}}'}</code>
      </p>
      {on && (
        <div style={{ marginTop: 10, display: 'grid', gap: 14 }}>
          {/* 연결 설정 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={lbl}>포트</span>
            <input style={{ ...input, width: 90, fontFamily: 'var(--fl-font-mono)' }} value={t.port ?? 9091} disabled={readOnly} onChange={(e) => set({ port: Number(e.target.value) || 0 })} />
            <span style={lbl}>인코딩</span>
            <select style={{ ...input, minWidth: 96 }} value={t.charset ?? 'EUC-KR'} disabled={readOnly} onChange={(e) => set({ charset: e.target.value })}>
              {ENCODINGS.map((c) => <option key={c}>{c}</option>)}
            </select>
            <span style={lbl}>길이 프리픽스</span>
            <input style={{ ...input, width: 60, fontFamily: 'var(--fl-font-mono)' }} value={t.prefixLength ?? 4} disabled={readOnly} onChange={(e) => set({ prefixLength: Number(e.target.value) || 0 })} />
            <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!t.prefixIncludesSelf} disabled={readOnly} onChange={(e) => set({ prefixIncludesSelf: e.target.checked })} />
              프리픽스 포함 길이
            </label>
            <span style={{ ...code, marginLeft: 'auto' }}>{`${window.location.hostname || 'localhost'}:${t.port ?? 9091}`}</span>
          </div>

          {/* 요청 레이아웃 */}
          <div style={box}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={boxTitle}>⬇ 요청 전문 레이아웃</span>
              <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>들어온 전문을 앞에서부터 바이트 길이대로 잘라 이름을 붙입니다 → 조건·<code style={code}>{'{{req.이름}}'}</code></span>
              <span style={{ ...code, marginLeft: 'auto' }}>총 {layout.reduce((a, f) => a + (f.length ?? 0), 0)}B</span>
            </div>
            <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
              {layout.map((f, i) => {
                const off = layout.slice(0, i).reduce((a, x) => a + (x.length ?? 0), 0)
                return (
                  <div key={f.id} style={row}>
                    <span style={offBadge} title={`시작 바이트 오프셋 ${off}`}>@{off}</span>
                    <input style={{ ...input, flex: 2, fontFamily: 'var(--fl-font-mono)' }} value={f.name ?? ''} placeholder="필드명 (예: 전문코드)" disabled={readOnly}
                      onChange={(e) => set({ requestFields: layout.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)) })} />
                    <input style={{ ...input, width: 64, fontFamily: 'var(--fl-font-mono)' }} type="number" value={f.length ?? 0} title="바이트 길이" disabled={readOnly}
                      onChange={(e) => set({ requestFields: layout.map((x) => (x.id === f.id ? { ...x, length: Number(e.target.value) } : x)) })} />
                    <select style={{ ...input, width: 92 }} value={f.encoding ?? ''} title="필드 인코딩(비면 서버 인코딩)" disabled={readOnly}
                      onChange={(e) => set({ requestFields: layout.map((x) => (x.id === f.id ? { ...x, encoding: e.target.value || undefined } : x)) })}>
                      <option value="">(서버)</option>{ENCODINGS.map((c) => <option key={c}>{c}</option>)}
                    </select>
                    {!readOnly && <>
                      <button style={miniBtn} onClick={() => set({ requestFields: move(layout, i, -1) })} title="위로">↑</button>
                      <button style={miniBtn} onClick={() => set({ requestFields: move(layout, i, 1) })} title="아래로">↓</button>
                      <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => set({ requestFields: layout.filter((x) => x.id !== f.id) })} aria-label="요청 필드 삭제">×</button>
                    </>}
                  </div>
                )
              })}
              {layout.length === 0 && <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>레이아웃 없음 — 규칙에서 <code style={code}>{'{{req:오프셋:길이}}'}</code> 슬라이스만 쓸 수 있습니다.</span>}
            </div>
            {!readOnly && <button style={{ ...miniBtn, marginTop: 8 }} onClick={() => set({ requestFields: [...layout, { id: newId(), name: '', length: 10 }] })}>+ 요청 필드</button>}
          </div>

          {/* 규칙 */}
          <div style={{ display: 'grid', gap: 8 }}>
            {rules.map((r, i) => (
              <TcpRuleCard key={r.id} rule={r} index={i} total={rules.length} layout={layout} readOnly={readOnly} sources={sources}
                onChange={(patch) => setRule(i, patch)}
                onMove={(d) => set({ rules: move(rules, i, d) })}
                onDup={() => { const copy = { ...r, id: newId(), responseFields: r.responseFields?.map((f) => ({ ...f, id: newId() })) }; set({ rules: [...rules.slice(0, i + 1), copy, ...rules.slice(i + 1)] }) }}
                onRemove={() => set({ rules: rules.filter((_, ri) => ri !== i) })} />
            ))}
            {!readOnly && <button style={{ ...miniBtn, justifySelf: 'start' }} onClick={() => set({ rules: [...rules, { id: newId(), contains: '', when: [], response: '', responseFields: [{ id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' }] }] })}>+ TCP 규칙</button>}
          </div>

          <TcpPreviewPanel tcp={t} layout={layout} codec={codec} environment={environment} />
        </div>
      )}
    </section>
  )
}

function TcpRuleCard({ rule: r, index, total, layout, readOnly, sources, onChange, onMove, onDup, onRemove }: {
  rule: MockTcpRuleSpec; index: number; total: number; layout: MockTcpReqField[]; readOnly?: boolean; sources: BindableSource[]
  onChange: (patch: Partial<MockTcpRuleSpec>) => void; onMove: (d: -1 | 1) => void; onDup: () => void; onRemove: () => void
}) {
  const fields = r.responseFields ?? []
  const [mode, setMode] = useState<'fields' | 'text'>(fields.length > 0 ? 'fields' : 'text')
  const conds = r.when ?? []
  const names = layout.map((f) => f.name ?? '').filter(Boolean)
  const setField = (fid: string, patch: Partial<MockTcpRespField>) => onChange({ responseFields: fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)) })
  const moveField = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= fields.length) return; const n = [...fields]; const x = n[i]; n[i] = n[j]; n[j] = x; onChange({ responseFields: n }) }
  const bodyTotal = fields.reduce((a, f) => a + (f.length ?? 0), 0)
  const isDefault = !r.contains && conds.every((c) => !c.field)
  const switchMode = (m: 'fields' | 'text') => {
    setMode(m)
    if (m === 'text') onChange({ responseFields: [] }) // 백엔드는 responseFields 가 비면 텍스트 템플릿 사용
    else if (fields.length === 0) onChange({ responseFields: [{ id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' }] })
  }
  return (
    <div style={{ border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 10 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', flexShrink: 0 }}>규칙 {index + 1}/{total} {isDefault && '(조건 없음 = 기본)'}</span>
        <span style={{ fontSize: 12, flexShrink: 0, marginLeft: 6 }}>요청에 포함:</span>
        <input style={{ ...input, flex: 1, minWidth: 140, fontFamily: 'var(--fl-font-mono)' }} value={r.contains ?? ''} placeholder="비우면 조건만 (예: BAL1)" disabled={readOnly} onChange={(e) => onChange({ contains: e.target.value })} />
        {!readOnly && <>
          <button style={miniBtn} onClick={onDup} title="규칙 복제">복제</button>
          <button style={miniBtn} onClick={() => onMove(-1)} title="위로">↑</button>
          <button style={miniBtn} onClick={() => onMove(1)} title="아래로">↓</button>
          <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onRemove}>규칙 삭제</button>
        </>}
      </div>

      {/* 필드 조건 */}
      <div style={{ marginTop: 6 }}>
        {conds.map((c, i) => (
          <div key={i} style={{ ...row, marginTop: 4 }}>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', width: 36 }}>{i === 0 ? '조건' : 'AND'}</span>
            <select style={{ ...input, minWidth: 120 }} value={c.field ?? ''} disabled={readOnly} onChange={(e) => onChange({ when: conds.map((x, xi) => (xi === i ? { ...x, field: e.target.value } : x)) })}>
              <option value="">필드 선택…</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
              {c.field && !names.includes(c.field) && <option value={c.field}>{c.field} (레이아웃에 없음)</option>}
            </select>
            <select style={{ ...input, width: 110 }} value={c.op ?? 'eq'} disabled={readOnly} onChange={(e) => onChange({ when: conds.map((x, xi) => (xi === i ? { ...x, op: e.target.value as MockTcpCond['op'] } : x)) })}>
              {COND_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={c.value ?? ''} placeholder="값" disabled={readOnly || c.op === 'exists'} onChange={(e) => onChange({ when: conds.map((x, xi) => (xi === i ? { ...x, value: e.target.value } : x)) })} />
            {!readOnly && <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => onChange({ when: conds.filter((_, xi) => xi !== i) })} aria-label="조건 삭제">×</button>}
          </div>
        ))}
        {!readOnly && <button style={{ ...miniBtn, marginTop: 4 }} disabled={names.length === 0} title={names.length === 0 ? '먼저 요청 레이아웃에 필드를 정의하세요' : undefined} onClick={() => onChange({ when: [...conds, { field: names[0] ?? '', op: 'eq', value: '' }] })}>+ 조건 (요청 필드 값으로 분기)</button>}
      </div>

      {/* 응답 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>⬆ 응답 전문</span>
        <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }}>
          {(['fields', 'text'] as const).map((m) => (
            <button key={m} disabled={readOnly} onClick={() => switchMode(m)} style={{ padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: mode === m ? 'var(--fl-primary)' : 'transparent', color: mode === m ? '#fff' : 'var(--fl-text-muted)' }}>{m === 'fields' ? '필드' : '텍스트'}</button>
          ))}
        </div>
        {mode === 'fields' && <span style={{ ...code, marginLeft: 'auto' }}>본문 {bodyTotal}B</span>}
      </div>
      {mode === 'fields' ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            {fields.map((f, i) => {
              const off = fields.slice(0, i).reduce((a, x) => a + (x.length ?? 0), 0)
              return (
                <div key={f.id} style={row}>
                  <span style={offBadge} title={`시작 바이트 오프셋 ${off} (본문 기준)`}>@{off}</span>
                  <input style={{ ...input, width: 110, fontFamily: 'var(--fl-font-mono)' }} value={f.name ?? ''} placeholder="이름" disabled={readOnly} onChange={(e) => setField(f.id, { name: e.target.value })} />
                  <input style={{ ...input, width: 58, fontFamily: 'var(--fl-font-mono)' }} type="number" value={f.length ?? 0} title="바이트 길이" disabled={readOnly} onChange={(e) => setField(f.id, { length: Number(e.target.value) })} />
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <TokenInput ariaLabel={`응답 필드 ${f.name || ''} 값`} value={f.value ?? ''} sources={sources} placeholder="값 — 고정값 또는 { } 요청 필드·시크릿" onChange={(v) => setField(f.id, { value: v })} />
                  </div>
                  <select style={{ ...input, width: 52 }} value={f.pad ?? 'right'} title="패딩 방향 (→ 우측 공백=문자, ← 좌측 0=숫자)" disabled={readOnly} onChange={(e) => setField(f.id, { pad: e.target.value as 'left' | 'right' })}>
                    <option value="right">→</option><option value="left">←</option>
                  </select>
                  <input style={{ ...input, width: 34, fontFamily: 'var(--fl-font-mono)', textAlign: 'center' }} maxLength={1} value={f.padChar ?? ' '} title="패딩 문자" disabled={readOnly} onChange={(e) => setField(f.id, { padChar: e.target.value })} />
                  <select style={{ ...input, width: 84 }} value={f.encoding ?? ''} title="필드 인코딩(비면 서버)" disabled={readOnly} onChange={(e) => setField(f.id, { encoding: e.target.value || undefined })}>
                    <option value="">(서버)</option>{ENCODINGS.map((c) => <option key={c}>{c}</option>)}
                  </select>
                  {!readOnly && <>
                    <button style={miniBtn} onClick={() => moveField(i, -1)} title="위로">↑</button>
                    <button style={miniBtn} onClick={() => moveField(i, 1)} title="아래로">↓</button>
                    <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => onChange({ responseFields: fields.filter((x) => x.id !== f.id) })} aria-label="응답 필드 삭제">×</button>
                  </>}
                </div>
              )
            })}
          </div>
          {!readOnly && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {/* 문자=우측 공백패딩, 숫자=좌측 0패딩(금융 전문 관례) */}
              <button style={miniBtn} title="우측 공백 패딩(문자 필드 관례)" onClick={() => onChange({ responseFields: [...fields, { id: newId(), name: '', length: 10, value: '', pad: 'right', padChar: ' ' }] })}>+ 문자 필드</button>
              <button style={miniBtn} title="좌측 0 패딩(숫자/금액 필드 관례)" onClick={() => onChange({ responseFields: [...fields, { id: newId(), name: '', length: 8, value: '0', pad: 'left', padChar: '0' }] })}>+ 숫자 필드</button>
            </div>
          )}
        </div>
      ) : (
        <textarea
          style={{ ...input, width: '100%', minHeight: 46, marginTop: 6, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
          value={r.response ?? ''} disabled={readOnly}
          placeholder={'응답 전문 텍스트 — 예: 0000{{req.계좌번호}}홍길동    (길이 직접 맞춰야 함 — 필드 모드 권장)'}
          onChange={(e) => onChange({ response: e.target.value })}
        />
      )}
    </div>
  )
}

/** 샘플 요청으로 요청 분해·매칭·응답 바이트를 저장 없이 확인. */
function TcpPreviewPanel({ tcp, layout, codec, environment }: { tcp: MockTcpSpec; layout: MockTcpReqField[]; codec?: MockCodecSpec | null; environment?: string | null }) {
  const [sample, setSample] = useState('')
  const [p, setP] = useState<MockTcpPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true); setErr(null)
    try { setP(await mocksApi.tcpPreview(tcp, sample, codec, environment)) } catch (e) { setP(null); setErr(apiErrorMessage(e, '미리보기 실패')) } finally { setBusy(false) }
  }
  const layoutTotal = layout.reduce((a, f) => a + (f.length ?? 0), 0)
  return (
    <div style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={boxTitle}>🔍 전문 미리보기</span>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>샘플 요청(프리픽스 제외 본문{layoutTotal ? `, 레이아웃 ${layoutTotal}B` : ''})을 넣으면 소켓 없이 요청 분해·매칭·응답 바이트를 계산합니다(미저장 편집 반영)</span>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={sample} placeholder="예: 02001234567890홍길동" onChange={(e) => setSample(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void run() }} />
        <button style={{ ...miniBtn, color: 'var(--fl-primary)', fontWeight: 700 }} disabled={busy} onClick={() => { void run() }}>{busy ? '…' : '미리보기'}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--fl-fail)', marginTop: 6 }}>{err}</div>}
      {p && (
        <div style={{ marginTop: 10, display: 'grid', gap: 10 }}>
          {p.decodedRequest != null && (
            <div>
              <div style={subTitle}>요청 코덱 적용 후 전문</div>
              <pre style={pre}>{p.decodedRequest}</pre>
            </div>
          )}
          {(p.codecSteps?.length ?? 0) > 0 && (
            <div>
              <div style={subTitle}>코덱 단계 ({p.codecSteps!.length})</div>
              <div style={{ display: 'grid', gap: 3 }}>
                {p.codecSteps!.map((st, i) => (
                  <div key={i} style={{ fontSize: 11, fontFamily: 'var(--fl-font-mono)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--fl-text-muted)' }}>{st.index + 1}. {st.id} · {st.target === 'body' ? '전체' : `필드 ${st.field}`}</span>
                    <span style={{ wordBreak: 'break-all' }}>{JSON.stringify(st.input)} → <b>{JSON.stringify(st.output)}</b></span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {p.requestFields.length > 0 && (
            <div>
              <div style={subTitle}>요청 분해 ({p.requestBytes}B · {p.encoding})</div>
              <div style={{ display: 'grid', gap: 2 }}>
                {p.requestFields.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)' }}>
                    <span style={offBadge}>@{f.offset}</span>
                    <span style={{ width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name || '(이름없음)'}</span>
                    <span style={{ color: 'var(--fl-text-muted)' }}>{f.length}B</span>
                    <code style={{ ...code, flex: 1 }}>{JSON.stringify(f.value)}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 12 }}>
            매칭 규칙: {p.matchedRuleIndex != null ? <b style={{ color: 'var(--fl-ok)' }}>규칙 {p.matchedRuleIndex + 1}</b> : <b style={{ color: 'var(--fl-fail)' }}>없음 (빈 응답)</b>}
            <span style={{ color: 'var(--fl-text-muted)' }}> · 응답 총 <b style={{ color: 'var(--fl-text)' }}>{p.totalBytes}B</b>{p.prefixLen > 0 && <> (프리픽스 {p.prefixLen}B{p.declaredPrefix != null ? `="${String(p.declaredPrefix).padStart(p.prefixLen, '0')}"` : ''} + 본문 {p.bodyBytes}B)</>}</span>
          </div>
          {p.fields.length > 0 && (
            <div style={{ display: 'grid', gap: 2 }}>
              {p.fields.map((f, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)' }}>
                  <span style={offBadge}>@{f.offset}</span>
                  <span style={{ width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name || '(이름없음)'}</span>
                  <span style={{ color: 'var(--fl-text-muted)' }}>{f.actualBytes}/{f.declaredLen}B</span>
                  <code style={{ ...code, flex: 1 }}>{JSON.stringify(f.text)}</code>
                  {f.truncated && <span title="값이 길이를 초과해 잘림" style={warnTag}>✂ 절단</span>}
                  {f.padded && <span title={`${f.pad === 'left' ? '좌측' : '우측'} 패딩으로 채움`} style={padTag}>{f.pad === 'left' ? '←' : '→'} 패딩</span>}
                </div>
              ))}
            </div>
          )}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={subTitle}>HEX</span><button style={{ ...miniBtn, padding: '1px 6px' }} onClick={() => { void navigator.clipboard?.writeText(p.hex).catch(() => {}) }}>복사</button></div>
            <pre style={pre}>{p.hex || '(빈 전문)'}</pre>
            <div style={subTitle}>텍스트</div>
            <pre style={pre}>{p.printable}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

const panel: CSSProperties = { marginTop: 22, padding: 18, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const h2: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const input: CSSProperties = { padding: '6px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const lbl: CSSProperties = { fontSize: 12 }
const box: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface-2)' }
const boxTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700 }
const subTitle: CSSProperties = { fontSize: 10.5, color: 'var(--fl-text-muted)', fontWeight: 700, margin: '4px 0 3px' }
const row: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const offBadge: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, color: 'var(--fl-text-muted)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 4, padding: '1px 5px', minWidth: 30, textAlign: 'center' }
const warnTag: CSSProperties = { fontSize: 9.5, fontWeight: 700, color: 'var(--fl-fail)', border: '1px solid var(--fl-fail)', borderRadius: 4, padding: '0 4px' }
const padTag: CSSProperties = { fontSize: 9.5, fontWeight: 700, color: 'var(--fl-text-muted)', border: '1px solid var(--fl-border)', borderRadius: 4, padding: '0 4px' }
const pre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }
