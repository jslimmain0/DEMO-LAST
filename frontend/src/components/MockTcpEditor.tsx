import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import type { MockCodecSpec, MockTcpCond, MockTcpPreview, MockTcpReqField, MockTcpRespField, MockTcpRuleSpec, MockTcpSpec } from '../api/types'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { mocksApi } from '../api/client'
import { apiErrorMessage } from '../lib/apiError'
import { newId } from '../lib/ids'
import { tcpLayoutForm, type LayoutRow } from '../lib/textForms'
import {
  incomingFrameLine, isLenFieldName, lenFieldWarning, lenFrameToken, lenToken, outgoingFrameLine, sumFieldBytes, tcpFrame,
} from '../lib/tcpLen'
import { FieldCodecButton } from './FieldCodecButton'
import { FieldTextToggle } from './FieldTextToggle'
import { TcpLayoutPasteButtons } from './TcpLayoutPaste'

const ENCODINGS = ['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII']
const COND_OPS: NonNullable<MockTcpCond['op']>[] = ['eq', 'ne', 'contains', 'startswith', 'endswith', 'regex', 'exists']

/**
 * TCP 전문 mock 편집 조각 — TCP 편집기(좌 목록 | 우 상세)가 조립한다. 항목별 **바이트 길이·패딩**으로 전문을 정의(한글 2바이트 등은 백엔드 계산).
 * - 연결: 포트·인코딩·길이 프리픽스.
 * - 요청 레이아웃: 들어온 전문을 앞에서부터 길이대로 잘라 필드명을 붙임 → 규칙 조건·{{ 이름@req }} 토큰. 필드마다 ◈ 코덱(요청 전 풀기).
 *   [필드|텍스트] 토글(한 줄 = 한 필드)·📋 정의서 붙여넣기로 엑셀 정의서를 통째로 옮길 수 있다.
 * - 규칙 상세: 조건(AND) + 응답 [필드 | 텍스트 | 템플릿(고급)]. 필드↔텍스트는 같은 모델의 두 보기(무손실),
 *   템플릿(고급)만 responseFields 를 버리는 파괴적 전환이라 2단계 확인을 받는다. 응답 필드마다 ◈ 코덱(응답 후 감싸기).
 * - 미리보기: 샘플 요청으로 요청 분해·매칭 규칙·응답 hex/오프셋/절단·패딩을 저장 없이 확인(트래픽 패널 탭).
 */

// 순수 기본값(React/axios 무의존, vitest node 환경에서 안전 — nodeFactory.ts 의 새 TCP 노드와 거울 고정 테스트가 이쪽을 직접 import).
export { defaultTcpSpec, defaultTcpRule, tcpRuleSummary } from '../lib/tcpDefaults'

// ---------- 연결 ----------

export function TcpConnectionPanel({ tcp, onChange, readOnly }: { tcp: MockTcpSpec; onChange: (patch: Partial<MockTcpSpec>) => void; readOnly?: boolean }) {
  const t = tcp
  return (
    <section style={panel}>
      <h2 style={h2}>연결 <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>(포트 · 인코딩 · 길이 프리픽스)</span></h2>
      <p style={hint}>
        저장하면 백엔드가 이 포트에 TCP 리스너를 엽니다(모든 인터페이스 바인딩 — 사내망 전제, 포트 충돌 시 저장 400). 워크플로의 <b>TCP 전문</b> 노드 대상을 <code style={code}>{`${window.location.hostname || 'localhost'}:${t.port ?? 9091}`}</code> 로.
        길이는 전부 <b>바이트</b>(EUC-KR 한글 2바이트).
      </p>
      <div style={{ display: 'grid', gap: 12, marginTop: 12, maxWidth: 560 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...lbl, minWidth: 90 }}>포트</span>
          <input style={{ ...input, width: 100, fontFamily: 'var(--fl-font-mono)' }} value={t.port ?? 9091} disabled={readOnly} aria-label="TCP 포트" onChange={(e) => onChange({ port: Number(e.target.value) || 0 })} />
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>1024~65535 · 한 포트에 Mock 하나</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...lbl, minWidth: 90 }}>인코딩</span>
          <select style={{ ...input, minWidth: 110 }} value={t.charset ?? 'EUC-KR'} disabled={readOnly} aria-label="인코딩" onChange={(e) => onChange({ charset: e.target.value })}>{ENCODINGS.map((c) => <option key={c}>{c}</option>)}</select>
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>전문 텍스트 ↔ 바이트 변환 기본값(필드별로 덮어쓸 수 있음)</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ ...lbl, minWidth: 90 }}>길이 프리픽스</span>
          <input style={{ ...input, width: 70, fontFamily: 'var(--fl-font-mono)' }} value={t.prefixLength ?? 4} disabled={readOnly} aria-label="길이 프리픽스" onChange={(e) => onChange({ prefixLength: Number(e.target.value) || 0 })} />
          <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={!!t.prefixIncludesSelf} disabled={readOnly} onChange={(e) => onChange({ prefixIncludesSelf: e.target.checked })} />
            프리픽스 포함 길이
          </label>
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>자리수(ASCII 숫자). 0 이면 프리픽스 없음 — 연결당 전문 1개</span>
        </div>
      </div>
    </section>
  )
}

// ---------- 요청 레이아웃 ----------

export function TcpLayoutPanel({ tcp, onChange, readOnly, codec, onCodec, sources }: {
  tcp: MockTcpSpec; onChange: (patch: Partial<MockTcpSpec>) => void; readOnly?: boolean
  codec: MockCodecSpec | null | undefined; onCodec: (c: MockCodecSpec | null) => void; sources: BindableSource[]
}) {
  // rows/form 은 안정된 참조여야 한다 — FieldTextToggle 이 이 둘을 effect 의존성으로 쓰기 때문(부모가 다른 이유로
  // 리렌더될 때(트래픽 패널 3초 폴링 등) 새 배열/새 form 이 들어가면 텍스트 편집 중인 버퍼가 되감긴다).
  const layout = useMemo(() => tcp.requestFields ?? [], [tcp.requestFields])
  const layoutForm = useMemo(() => tcpLayoutForm('layout'), [])
  const setLayout = (next: MockTcpReqField[]) => onChange({ requestFields: next })
  // 들어올 전문의 모습(본문 · 프리픽스 값) — 길이가 둘이라 헷갈리는 지점을 늘 펴 보여준다.
  const frame = tcpFrame(sumFieldBytes(layout), tcp.prefixLength ?? 4, tcp.prefixIncludesSelf)
  return (
    <section style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={h2}>⬇ 요청 레이아웃</h2>
        <span style={{ ...code, marginLeft: 'auto' }}>본문 {frame.body}B</span>
      </div>
      <p style={hint}>
        들어온 전문(프리픽스 제외)을 앞에서부터 <b>바이트 길이</b>대로 잘라 이름을 붙입니다 → 규칙 조건·응답 값의 <code style={code}>{'{{ 이름@req }}'}</code>.
        필드 값이 암호화/인코딩돼 오면 그 필드의 <b>◈</b> 로 요청 전 풀기 코덱을 겁니다(매칭·템플릿 전에 적용).
      </p>
      {/* 들어올 전문의 길이 산술 — 프리픽스 값이 본문만인지 프리픽스까지 포함인지가 여기서 갈린다 */}
      <div style={lenLine} title="본문 = 요청 필드 선언 길이의 합. 앞에 붙는 길이 프리픽스는 연결 설정에서 정합니다.">{incomingFrameLine(frame)}</div>
      <div style={{ marginTop: 10 }}>
        <FieldTextToggle<LayoutRow>
          form={layoutForm} rows={layout as LayoutRow[]} onChange={(r) => setLayout(r as MockTcpReqField[])}
          readOnly={readOnly} ariaLabel="요청 레이아웃"
          summary={(r) => `본문 ${sumFieldBytes(r)}B · ${r.length}필드`}
          extras={<TcpLayoutPasteButtons mode="layout" rows={layout as LayoutRow[]} encoding={tcp.charset ?? 'EUC-KR'}
            prefixLength={tcp.prefixLength ?? 4} prefixIncludesSelf={!!tcp.prefixIncludesSelf} readOnly={readOnly}
            onApply={(rows, how) => setLayout((how === 'replace' ? rows : [...(layout as LayoutRow[]), ...rows]) as MockTcpReqField[])} />}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            {layout.map((f, i) => {
              const off = layout.slice(0, i).reduce((a, x) => a + (x.length ?? 0), 0)
              return (
                <div key={f.id} style={row}>
                  <span style={offBadge} title={`시작 바이트 오프셋 ${off}`}>@{off}</span>
                  <input style={{ ...input, flex: 2, minWidth: 140, fontFamily: 'var(--fl-font-mono)' }} value={f.name ?? ''} placeholder="필드명 (예: 전문코드)" disabled={readOnly}
                    onChange={(e) => setLayout(layout.map((x) => (x.id === f.id ? { ...x, name: e.target.value } : x)))} />
                  <input style={{ ...input, width: 64, fontFamily: 'var(--fl-font-mono)' }} type="number" value={f.length ?? 0} title="바이트 길이" disabled={readOnly}
                    onChange={(e) => setLayout(layout.map((x) => (x.id === f.id ? { ...x, length: Number(e.target.value) } : x)))} />
                  <select style={{ ...input, width: 92 }} value={f.encoding ?? ''} title="필드 인코딩(비면 서버 인코딩)" disabled={readOnly}
                    onChange={(e) => setLayout(layout.map((x) => (x.id === f.id ? { ...x, encoding: e.target.value || undefined } : x)))}>
                    <option value="">(서버)</option>{ENCODINGS.map((c) => <option key={c}>{c}</option>)}
                  </select>
                  <FieldCodecButton field={(f.name ?? '').trim()} codec={codec} onChange={onCodec} sources={sources} defaultSide="request" sides={['request']} kind="tcp" readOnly={readOnly} />
                  {!readOnly && <>
                    <button style={miniBtn} onClick={() => setLayout(move(layout, i, -1))} title="위로">↑</button>
                    <button style={miniBtn} onClick={() => setLayout(move(layout, i, 1))} title="아래로">↓</button>
                    <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => setLayout(layout.filter((x) => x.id !== f.id))} aria-label="요청 필드 삭제">×</button>
                  </>}
                </div>
              )
            })}
            {layout.length === 0 && <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>레이아웃 없음 — 규칙에서 <code style={code}>{'{{req:오프셋:길이}}'}</code> 슬라이스만 쓸 수 있습니다. [텍스트] 또는 📋 로 정의서를 한 번에 옮길 수 있습니다.</span>}
          </div>
          {!readOnly && <button style={{ ...miniBtn, marginTop: 8 }} onClick={() => setLayout([...layout, { id: newId(), name: '', length: 10 }])}>+ 요청 필드</button>}
        </FieldTextToggle>
      </div>
    </section>
  )
}

// ---------- 규칙 상세 ----------

export function TcpRuleDetail({ rule: r, index, total, layout, readOnly, sources, codec, onCodec, tcpCharset, prefixLength, prefixIncludesSelf, onChange, onMove, onDup, onRemove }: {
  rule: MockTcpRuleSpec; index: number; total: number; layout: MockTcpReqField[]; readOnly?: boolean; sources: BindableSource[]
  codec: MockCodecSpec | null | undefined; onCodec: (c: MockCodecSpec | null) => void
  tcpCharset: string // 서버 인코딩 — 붙여넣기 대화상자의 바이트 길이 대조 기준
  // 연결 설정의 길이 프리픽스 — 나가는 전문 길이 산술용(선택: 안 넘기면 프리픽스 산술을 생략하고 본문만 표시).
  prefixLength?: number | null; prefixIncludesSelf?: boolean | null
  onChange: (patch: Partial<MockTcpRuleSpec>) => void; onMove: (d: -1 | 1) => void; onDup: () => void; onRemove: () => void
}) {
  const fields = useMemo(() => r.responseFields ?? [], [r.responseFields]) // 안정된 참조 — 위 TcpLayoutPanel 주석 참조
  const respForm = useMemo(() => tcpLayoutForm('request'), []) // Mock 응답 필드 = 값·패딩이 있는 '요청' 성격(노드 응답 파싱 필드와 다름)
  // 필드 0개 + response 템플릿만 있는 기존 규칙 = 템플릿(고급) 모드로 연다(백엔드 규약: responseFields 가 비면 텍스트 템플릿).
  const [mode, setMode] = useState<'fields' | 'text' | 'template'>(fields.length > 0 ? 'fields' : 'template')
  const [confirmTpl, setConfirmTpl] = useState(false)
  const conds = r.when ?? []
  const names = layout.map((f) => f.name ?? '').filter(Boolean)
  const setField = (fid: string, patch: Partial<MockTcpRespField>) => onChange({ responseFields: fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)) })
  const moveField = (i: number, d: -1 | 1) => onChange({ responseFields: move(fields, i, d) })
  const bodyTotal = sumFieldBytes(fields)
  // 나가는 전문의 길이 산술 — 프리픽스 폭을 모르면(부모가 안 넘김) 프리픽스 산술과 불일치 경고를 생략한다(오경고 방지).
  const prefixKnown = prefixLength != null
  const outFrame = tcpFrame(bodyTotal, prefixLength ?? 0, prefixIncludesSelf)
  const isDefault = !r.contains && conds.every((c) => !c.field)
  // [필드 | 텍스트] 는 같은 responseFields 의 두 보기(무손실 왕복). 템플릿(고급)만 responseFields 를 버리는 파괴적 전환 → 2단계 확인.
  const switchMode = (m: 'fields' | 'text' | 'template') => {
    if (m === 'template') {
      if (fields.length > 0 && !confirmTpl) { setConfirmTpl(true); return }
      setConfirmTpl(false); setMode('template'); onChange({ responseFields: [] }) // 백엔드는 responseFields 가 비면 텍스트 템플릿 사용
      return
    }
    setConfirmTpl(false)
    // 시드는 템플릿에서 돌아올 때만 — 필드↔텍스트 전환에서 시드하면 텍스트에서 방금 파싱한 행(onChange 직후)을 덮어쓴다.
    if (mode === 'template' && fields.length === 0) onChange({ responseFields: [{ id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' }] })
    setMode(m)
  }
  return (
    <section style={panel}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={h2}>규칙 {index + 1}<span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}> / {total}{isDefault ? ' · 조건 없음 = 기본' : ''}</span></h2>
        <span style={{ marginLeft: 'auto' }} />
        {!readOnly && <>
          <button style={miniBtn} onClick={onDup} title="규칙 복제">복제</button>
          <button style={miniBtn} onClick={() => onMove(-1)} title="위로 (위에서부터 첫 매칭)">↑</button>
          <button style={miniBtn} onClick={() => onMove(1)} title="아래로">↓</button>
          <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onRemove}>규칙 삭제</button>
        </>}
      </div>
      <p style={hint}>위에서부터 첫 매칭. 조건은 모두 만족(AND) — 요청에 포함된 문자열과 요청 레이아웃 필드 값으로 분기합니다.</p>

      {/* 매칭 */}
      <div style={{ ...box, marginTop: 10 }}>
        <div style={boxTitle}>⬇ 언제 응답할까 (매칭)</div>
        <div style={{ ...row, marginTop: 8 }}>
          <span style={{ fontSize: 12, minWidth: 82 }}>요청에 포함</span>
          <input style={{ ...input, flex: 1, minWidth: 140, fontFamily: 'var(--fl-font-mono)' }} value={r.contains ?? ''} placeholder="비우면 조건만 (예: BAL1)" disabled={readOnly} onChange={(e) => onChange({ contains: e.target.value })} />
        </div>
        {conds.map((c, i) => (
          <div key={i} style={{ ...row, marginTop: 6 }}>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', minWidth: 82 }}>{i === 0 ? '조건' : 'AND'}</span>
            <select style={{ ...input, minWidth: 130 }} value={c.field ?? ''} disabled={readOnly} onChange={(e) => onChange({ when: conds.map((x, xi) => (xi === i ? { ...x, field: e.target.value } : x)) })}>
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
        {!readOnly && <button style={{ ...miniBtn, marginTop: 8 }} disabled={names.length === 0} title={names.length === 0 ? '먼저 요청 레이아웃에 필드를 정의하세요' : undefined} onClick={() => onChange({ when: [...conds, { field: names[0] ?? '', op: 'eq', value: '' }] })}>+ 조건 (요청 필드 값으로 분기)</button>}
      </div>

      {/* 응답 */}
      <div style={{ ...box, marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={boxTitle}>⬆ 응답 전문</span>
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>값: <code style={code}>{'{{ 필드@req }}'}</code> 요청 필드 · <code style={code}>{'{{ 이름@secret }}'}</code> 시크릿 · <code style={code}>{'{{seq}}'}</code> <code style={code}>{'{{now}}'}</code> · 전문 안 길이 필드는 <code style={code}>{'{{len:4}}'}</code>(본문)·<code style={code}>{'{{len:frame:4}}'}</code>(프리픽스 포함) · 길이 프리픽스 자체는 자동</span>
          {/* 응답 길이 산술 — 필드 합계에 길이 프리픽스가 붙어 나간다(둘을 한 줄에) */}
          {mode !== 'template' && (
            <span style={{ ...code, marginLeft: 'auto' }} title="응답 필드 선언 길이의 합 + 연결 설정의 길이 프리픽스 = 실제로 나가는 바이트">
              {prefixKnown ? outgoingFrameLine(outFrame) : `응답 본문 ${bodyTotal}B · 프리픽스는 연결 설정대로 자동`}
            </span>
          )}
        </div>
        {mode === 'template' ? (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>평문 템플릿 — 길이를 직접 맞춰야 합니다(필드 모드 권장)</span>
              {!readOnly && <button style={miniBtn} onClick={() => switchMode('fields')}>필드 모드로</button>}
            </div>
            <textarea
              style={{ ...input, width: '100%', minHeight: 46, marginTop: 8, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
              value={r.response ?? ''} disabled={readOnly} aria-label="응답 전문 템플릿"
              placeholder={'응답 전문 텍스트 — 예: 0000{{req.계좌번호}}홍길동    (길이 직접 맞춰야 함 — 필드 모드 권장)'}
              onChange={(e) => onChange({ response: e.target.value })}
            />
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <FieldTextToggle<LayoutRow>
              form={respForm} rows={fields as LayoutRow[]} onChange={(rows) => onChange({ responseFields: rows as MockTcpRespField[] })}
              readOnly={readOnly} ariaLabel="응답 필드"
              mode={mode === 'text' ? 'text' : 'fields'} onModeChange={(m) => switchMode(m)}
              summary={(rs) => `본문 ${rs.reduce((a, f) => a + (f.length ?? 0), 0)}B · ${rs.length}필드`}
              extras={<>
                <TcpLayoutPasteButtons mode="request" rows={fields as LayoutRow[]} encoding={tcpCharset} prefixLength={0} prefixIncludesSelf={false} readOnly={readOnly} compact
                  onApply={(rows, how) => onChange({ responseFields: (how === 'replace' ? rows : [...(fields as LayoutRow[]), ...rows]) as MockTcpRespField[] })} />
                {!readOnly && <button style={miniBtn} onClick={() => switchMode('template')} title="필드 정의를 버리고 평문 템플릿으로(고급) — 길이를 직접 맞춰야 합니다">템플릿(고급)</button>}
                {confirmTpl && (
                  <span style={{ fontSize: 11.5, color: 'var(--fl-put, #f5a623)', display: 'inline-flex', gap: 6, alignItems: 'center' }} role="alert">
                    필드 {fields.length}개 정의를 버립니다
                    <button style={miniBtn} onClick={() => switchMode('template')}>확인</button>
                    <button style={miniBtn} onClick={() => setConfirmTpl(false)}>취소</button>
                  </span>
                )}
              </>}
            >
              <div style={{ display: 'grid', gap: 4 }}>
                {fields.map((f, i) => {
                  const off = sumFieldBytes(fields.slice(0, i))
                  // 전문 안 길이 필드(length/len/길이…)에 손으로 적은 숫자 대조 — 자문일 뿐 편집을 막지 않는다.
                  const lenish = isLenFieldName(f.name)
                  const warn = prefixKnown ? lenFieldWarning({ name: f.name, length: f.length, value: f.value }, outFrame) : null
                  return (
                    <div key={f.id} style={{ display: 'contents' }}>
                    <div style={row}>
                      <span style={offBadge} title={`시작 바이트 오프셋 ${off} (본문 기준)`}>@{off}</span>
                      <input style={{ ...input, width: 110, fontFamily: 'var(--fl-font-mono)' }} value={f.name ?? ''} placeholder="이름" disabled={readOnly} onChange={(e) => setField(f.id, { name: e.target.value })} />
                      <input style={{ ...input, width: 58, fontFamily: 'var(--fl-font-mono)' }} type="number" value={f.length ?? 0} title="바이트 길이" disabled={readOnly} onChange={(e) => setField(f.id, { length: Number(e.target.value) })} />
                      <div style={{ flex: 1, minWidth: 180 }}>
                        <TokenInput ariaLabel={`응답 필드 ${f.name || ''} 값`} value={f.value ?? ''} sources={sources} placeholder="값 — 고정값 또는 { } 요청 필드·시크릿" onChange={(v) => setField(f.id, { value: v })} />
                      </div>
                      {/* 방향 글리프가 네이티브 셀렉트 화살표에 잘리지 않게 — 좌우 패딩을 줄이고 폭을 확보 */}
                      <select style={{ ...input, width: 80, padding: '6px 6px' }} value={f.pad ?? 'right'} aria-label="패딩 방향" title="패딩 방향 (→ 우측 공백=문자, ← 좌측 0=숫자)" disabled={readOnly} onChange={(e) => setField(f.id, { pad: e.target.value as 'left' | 'right' })}>
                        <option value="right">→ 우측</option><option value="left">← 좌측</option>
                      </select>
                      <input style={{ ...input, width: 42, fontFamily: 'var(--fl-font-mono)', textAlign: 'center', padding: '6px 6px' }} maxLength={1} value={f.padChar ?? ' '} aria-label="패딩 문자" title="패딩 문자(문자 필드는 공백, 숫자 필드는 0)" disabled={readOnly} onChange={(e) => setField(f.id, { padChar: e.target.value })} />
                      <select style={{ ...input, width: 84 }} value={f.encoding ?? ''} title="필드 인코딩(비면 서버)" disabled={readOnly} onChange={(e) => setField(f.id, { encoding: e.target.value || undefined })}>
                        <option value="">(서버)</option>{ENCODINGS.map((c) => <option key={c}>{c}</option>)}
                      </select>
                      <FieldCodecButton field={(f.name ?? '').trim()} codec={codec} onChange={onCodec} sources={sources} defaultSide="response" sides={['response']} kind="tcp" readOnly={readOnly} />
                      {lenish && !readOnly && (
                        <button style={lenBtn} onClick={() => setField(f.id, { value: lenToken(f.length) })}
                          aria-label={`${f.name || '길이'} 필드에 길이 토큰 넣기`}
                          title={`응답 전문 길이를 자동으로 채웁니다 — ${lenToken(f.length)}(본문 ${bodyTotal}B). 프리픽스 포함 전체가 필요하면 값을 ${lenFrameToken(f.length)} 로 고치세요.`}
                        >{'{{len}}'}</button>
                      )}
                      {!readOnly && <>
                        <button style={miniBtn} onClick={() => moveField(i, -1)} title="위로">↑</button>
                        <button style={miniBtn} onClick={() => moveField(i, 1)} title="아래로">↓</button>
                        <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => onChange({ responseFields: fields.filter((x) => x.id !== f.id) })} aria-label="응답 필드 삭제">×</button>
                      </>}
                    </div>
                    {warn && <div style={lenWarn} role="status" title={warn}>⚠ {warn}</div>}
                    </div>
                  )
                })}
                {fields.length === 0 && <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>응답 필드 없음 — <b>+ 문자/숫자 필드</b>·[텍스트]·📋 로 채우세요(비운 채 저장하면 아래 평문 템플릿이 나갑니다).</span>}
              </div>
              {!readOnly && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  {/* 문자=우측 공백패딩, 숫자=좌측 0패딩(금융 전문 관례) */}
                  <button style={miniBtn} title="우측 공백 패딩(문자 필드 관례)" onClick={() => onChange({ responseFields: [...fields, { id: newId(), name: '', length: 10, value: '', pad: 'right', padChar: ' ' }] })}>+ 문자 필드</button>
                  <button style={miniBtn} title="좌측 0 패딩(숫자/금액 필드 관례)" onClick={() => onChange({ responseFields: [...fields, { id: newId(), name: '', length: 8, value: '0', pad: 'left', padChar: '0' }] })}>+ 숫자 필드</button>
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', marginTop: 6 }}>응답 필드가 암호화/인코딩돼 나가야 하면 그 필드의 <b>◈</b> 로 응답 후 감싸기 코덱(패딩 전에 적용).</div>
            </FieldTextToggle>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- 미리보기(트래픽 패널 탭) ----------

/** 샘플 요청으로 요청 분해·매칭·응답 바이트를 저장 없이 확인. */
export function TcpPreviewPanel({ tcp, codec, environment, onSelectRule, sample: sampleProp, onSample }: {
  tcp: MockTcpSpec; codec?: MockCodecSpec | null; environment?: string | null; onSelectRule?: (ruleId: string) => void
  sample?: string; onSample?: (s: string) => void // 제어형(트래픽 패널이 요청 기록 → 샘플로 넘길 때)
}) {
  const layout = tcp.requestFields ?? []
  const [local, setLocal] = useState('')
  const sample = sampleProp ?? local
  const setSample = onSample ?? setLocal
  const [p, setP] = useState<MockTcpPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true); setErr(null)
    try { setP(await mocksApi.tcpPreview(tcp, sample, codec, environment)) } catch (e) { setP(null); setErr(apiErrorMessage(e, '미리보기 실패')) } finally { setBusy(false) }
  }
  const layoutTotal = layout.reduce((a, f) => a + (f.length ?? 0), 0)
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px 10px', display: 'grid', gap: 8, alignContent: 'start' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>샘플 요청(프리픽스 제외 본문{layoutTotal ? `, 레이아웃 ${layoutTotal}B` : ''}) — 소켓 없이 요청 분해·매칭·응답 바이트를 계산합니다(미저장 편집 반영)</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={sample} placeholder="예: 02001234567890홍길동" aria-label="샘플 요청 전문" onChange={(e) => setSample(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void run() }} />
        <button style={{ ...miniBtn, color: 'var(--fl-primary)', fontWeight: 700 }} disabled={busy} onClick={() => { void run() }}>{busy ? '…' : '🔍 미리보기'}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--fl-fail)' }}>{err}</div>}
      {p && (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
          <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
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
              매칭 규칙: {p.matchedRuleIndex != null
                ? <b style={{ color: 'var(--fl-ok)', cursor: onSelectRule ? 'pointer' : undefined }} onClick={() => { if (p.matchedRuleId && onSelectRule) onSelectRule(p.matchedRuleId) }} title={onSelectRule ? '이 규칙 열기' : undefined}>규칙 {p.matchedRuleIndex + 1}</b>
                : <b style={{ color: 'var(--fl-fail)' }}>없음 (빈 응답)</b>}
              <span style={{ color: 'var(--fl-text-muted)' }}> · 응답 총 <b style={{ color: 'var(--fl-text)' }}>{p.totalBytes}B</b>{p.prefixLen > 0 && <> (프리픽스 {p.prefixLen}B{p.declaredPrefix != null ? `="${String(p.declaredPrefix).padStart(p.prefixLen, '0')}"` : ''} + 본문 {p.bodyBytes}B)</>}</span>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            {p.fields.length > 0 && (
              <div style={{ display: 'grid', gap: 2 }}>
                <div style={subTitle}>응답 필드</div>
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
        </div>
      )}
    </div>
  )
}

function move<T>(arr: T[], i: number, d: -1 | 1): T[] { const j = i + d; if (j < 0 || j >= arr.length) return arr; const n = [...arr]; const x = n[i]; n[i] = n[j]; n[j] = x; return n }

const panel: CSSProperties = { padding: 18, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const h2: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const input: CSSProperties = { padding: '6px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5 }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const lbl: CSSProperties = { fontSize: 12, fontWeight: 700 }
// TCP 길이 산술 — 본문/프리픽스/전송 세 숫자를 늘 보여주는 한 줄(숫자가 많아 mono)
const lenLine: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', marginTop: 6, lineHeight: 1.5 }
// 전문 안 길이 필드 불일치 — 자문(주황), 편집을 막지 않는다
const lenWarn: CSSProperties = { fontSize: 11, color: 'var(--fl-put)', lineHeight: 1.5, paddingLeft: 36 }
const lenBtn: CSSProperties = { flexShrink: 0, padding: '4px 6px', border: '1px solid color-mix(in srgb, var(--fl-primary) 45%, var(--fl-border))', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 10.5, fontFamily: 'var(--fl-font-mono)', fontWeight: 700 }
const box: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface-2)' }
const boxTitle: CSSProperties = { fontSize: 12.5, fontWeight: 700 }
const subTitle: CSSProperties = { fontSize: 10.5, color: 'var(--fl-text-muted)', fontWeight: 700, margin: '4px 0 3px' }
const row: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const offBadge: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, color: 'var(--fl-text-muted)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 4, padding: '1px 5px', minWidth: 30, textAlign: 'center' }
const warnTag: CSSProperties = { fontSize: 9.5, fontWeight: 700, color: 'var(--fl-fail)', border: '1px solid var(--fl-fail)', borderRadius: 4, padding: '0 4px' }
const padTag: CSSProperties = { fontSize: 9.5, fontWeight: 700, color: 'var(--fl-text-muted)', border: '1px solid var(--fl-border)', borderRadius: 4, padding: '0 4px' }
const pre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }
