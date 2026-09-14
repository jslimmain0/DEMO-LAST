import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { mocksApi } from '../api/client'
import type { MockTcpPreview } from '../api/types'
import { parseTcpLayout, tcpLayoutToText, type LayoutMode, type LayoutRow, type ParseWarning } from '../lib/textForms'
import { detectPrefix } from '../lib/tcpSample'
import { Modal } from './Modal'
import { toast } from './toast'

const MODE_LABEL: Record<LayoutMode, string> = { request: '요청 필드(값·패딩)', response: '응답 필드', layout: '요청 레이아웃' }

/** 📋 정의서 붙여넣기 + ⧉ 텍스트 복사 — 노드 요청/응답 필드·Mock 레이아웃/응답 필드 4곳이 같은 버튼을 쓴다. */
export function TcpLayoutPasteButtons({ mode, rows, encoding, prefixLength, prefixIncludesSelf, onApply, readOnly, compact }: {
  mode: LayoutMode; rows: LayoutRow[]; encoding: string; prefixLength: number; prefixIncludesSelf: boolean
  onApply: (rows: LayoutRow[], how: 'replace' | 'append') => void; readOnly?: boolean; compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const copy = () => {
    const text = tcpLayoutToText(rows, mode)
    void navigator.clipboard?.writeText(text).then(() => toast(`${rows.length}개 필드를 텍스트로 복사했습니다 — 노드/Mock 어디든 📋 로 붙여넣기`, 'ok')).catch(() => toast('복사 실패', 'error'))
  }
  return (
    <>
      {!readOnly && <button type="button" style={btn} onClick={() => setOpen(true)} title="엑셀 정의서 행(항목명/길이/타입/기본값) · 한 줄 문법 · 노드/Mock 에서 복사한 텍스트">📋 {compact ? '' : '정의서 '}붙여넣기</button>}
      <button type="button" style={btn} onClick={copy} disabled={rows.length === 0} title="현재 필드를 텍스트로 복사">⧉ {compact ? '' : '텍스트 '}복사</button>
      {open && <PasteDialog mode={mode} prev={rows} encoding={encoding} prefixLength={prefixLength} prefixIncludesSelf={prefixIncludesSelf} onClose={() => setOpen(false)} onApply={(r, how) => { onApply(r, how); setOpen(false) }} />}
    </>
  )
}

function PasteDialog({ mode, prev, encoding, prefixLength, prefixIncludesSelf, onClose, onApply }: {
  mode: LayoutMode; prev: LayoutRow[]; encoding: string; prefixLength: number; prefixIncludesSelf: boolean
  onClose: () => void; onApply: (rows: LayoutRow[], how: 'replace' | 'append') => void
}) {
  const [text, setText] = useState('')
  const [sample, setSample] = useState('')
  const [how, setHow] = useState<'replace' | 'append'>(prev.length ? 'replace' : 'append')
  const parsed = useMemo(() => parseTcpLayout(text, mode, how === 'replace' ? prev : []), [text, mode, prev, how])
  const total = parsed.rows.reduce((a, r) => a + (r.length ?? 0), 0)
  const [preview, setPreview] = useState<MockTcpPreview | null>(null)
  const [prevErr, setPrevErr] = useState<string | null>(null)
  const prefix = useMemo(() => detectPrefix(sample, prefixLength), [sample, prefixLength])

  // 샘플 전문 대조 — 기존 tcp-preview 에 일회용 spec(프리픽스 0 = 샘플을 본문으로) 을 실어 레이아웃대로 잘라 본다(저장·소켓 없음)
  // 요청마다 일련번호를 매겨, 먼저 보낸 느린 응답이 나중 응답을 덮어쓰지 않게 한다(마지막 요청만 반영).
  const seq = useRef(0)
  useEffect(() => {
    if (!sample.trim() || parsed.rows.length === 0) { seq.current++; setPreview(null); setPrevErr(null); return }
    const body = prefix.kind === 'excl' || prefix.kind === 'incl' ? sample.slice(prefixLength) : sample
    const ticket = seq // 정리 함수에서 쓸 동일 ref 객체(카운터라 최신 값이 필요 — exhaustive-deps 의 권장 회피)
    const t = window.setTimeout(() => {
      const my = ++seq.current
      mocksApi.tcpPreview({ charset: encoding, prefixLength: 0, prefixIncludesSelf: false, enabled: false, port: 0,
        requestFields: parsed.rows.map((r) => ({ id: r.id, name: r.name, length: r.length, encoding: r.encoding })), rules: [] }, body)
        .then((p) => { if (my === seq.current) { setPreview(p); setPrevErr(null) } })
        .catch((e) => { if (my === seq.current) { setPreview(null); setPrevErr(e instanceof Error ? e.message : String(e)) } })
    }, 300)
    return () => { ticket.current++; window.clearTimeout(t) }
  }, [sample, parsed.rows, encoding, prefixLength, prefix.kind])

  const sampleValues = preview?.requestFields ?? []
  const remain = preview ? preview.requestBytes - total : null
  return (
    <Modal onClose={onClose} ariaLabel="정의서 붙여넣기" width={960}>
      <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
        <div>
          <div style={h}>📋 {MODE_LABEL[mode]} 붙여넣기</div>
          <p style={hint}>엑셀 정의서에서 <b>항목명 · 길이 · 타입(AN/N) · 기본값</b> 열을 복사해 붙여넣거나, 한 줄 문법(<code>이름 길이 종류 [= 값]</code>)으로 적으세요. 길이는 <b>바이트</b>(EUC-KR 한글 2바이트). 타입 N/9/숫자 → 좌측 0 패딩, 나머지 → 우측 공백.</p>
          <textarea aria-label="정의서 텍스트" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ ...ta, minHeight: 220 }}
            placeholder={'항목명\t길이\t타입\t기본값\n전문코드\t4\tAN\t0200\n계좌번호\t12\tN\n고객명\t10\tK\n\n또는\n전문코드 4 문자 = 0200\n계좌번호 12 숫자 = {{ acct@set1 }}'} />
          <label style={{ ...lbl, marginTop: 10 }}>샘플 전문(선택) — 로그에서 복사한 실제 전문 한 줄</label>
          <input aria-label="샘플 전문" value={sample} onChange={(e) => setSample(e.target.value)} style={{ ...ta, minHeight: 0, fontFamily: 'var(--fl-font-mono)' }} placeholder="001402001234567890" />
          {prefix.message && <p style={{ ...hint, color: prefix.kind === 'mismatch' ? 'var(--fl-put, #f5a623)' : prefix.kind === 'none' ? 'var(--fl-text-muted)' : 'var(--fl-ok)' }}>{prefix.message}{(prefix.kind === 'excl') !== !prefixIncludesSelf && prefix.kind !== 'none' && prefix.kind !== 'mismatch' ? ' — 현재 설정과 다릅니다' : ''}</p>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={h}>미리보기 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}>{parsed.rows.length}필드 · 총 {total}B{parsed.headerMapped ? ' · 헤더 열 매핑' : ''}</span></div>
          {parsed.warnings.length > 0 && <ul style={warn} role="alert">{parsed.warnings.map((w: ParseWarning, i) => <li key={i}><b>{w.line}행</b> {w.reason}</li>)}</ul>}
          <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--fl-font-mono)' }}>
              <thead><tr style={{ color: 'var(--fl-text-muted)' }}><th style={th}>@</th><th style={th}>이름</th><th style={th}>길이</th>{mode === 'request' && <><th style={th}>패딩</th><th style={th}>값</th></>}{mode === 'response' && <th style={th}>종류</th>}{sample && <th style={th}>샘플</th>}</tr></thead>
              <tbody>
                {parsed.rows.map((r, i) => {
                  const off = parsed.rows.slice(0, i).reduce((a, x) => a + (x.length ?? 0), 0)
                  return (
                    <tr key={r.id}><td style={td}>{off}</td><td style={td}>{r.name}</td><td style={td}>{r.length}</td>
                      {mode === 'request' && <><td style={td}>{r.pad === 'left' ? '←' : '→'}{JSON.stringify(r.padChar ?? ' ')}</td><td style={td}>{r.value ?? ''}</td></>}
                      {mode === 'response' && <td style={td}>{r.type === 'number' ? '숫자' : r.type === 'string' ? '문자' : ''}</td>}
                      {sample && <td style={td}>{sampleValues[i] ? JSON.stringify(sampleValues[i].value) : ''}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {preview && <p style={{ ...hint, color: remain === 0 ? 'var(--fl-ok)' : 'var(--fl-put, #f5a623)' }}>샘플 {preview.requestBytes}B vs 레이아웃 {total}B {remain === 0 ? '✓ 일치' : remain! > 0 ? `✗ 샘플이 ${remain}B 남음(필드가 모자람)` : `✗ 레이아웃이 ${-remain!}B 더 김`}</p>}
          {prevErr && <p style={{ ...hint, color: 'var(--fl-fail)' }}>샘플 대조 실패: {prevErr}</p>}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <label style={lbl}><input type="radio" checked={how === 'replace'} onChange={() => setHow('replace')} /> 기존 {prev.length}개 교체</label>
            <label style={lbl}><input type="radio" checked={how === 'append'} onChange={() => setHow('append')} /> 아래에 추가</label>
            <span style={{ marginLeft: 'auto' }} />
            <button type="button" style={btn} onClick={onClose}>취소</button>
            <button type="button" style={{ ...btn, background: 'var(--fl-primary)', color: '#fff', borderColor: 'var(--fl-primary)' }} disabled={parsed.rows.length === 0} onClick={() => onApply(parsed.rows, how)}>적용 ({parsed.rows.length}개)</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

const btn: CSSProperties = { fontSize: 11.5, padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer' }
const h: CSSProperties = { fontSize: 13.5, fontWeight: 800, marginBottom: 6 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', margin: '4px 0 8px', lineHeight: 1.5 }
const lbl: CSSProperties = { fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }
const ta: CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', resize: 'vertical' }
const warn: CSSProperties = { margin: '0 0 6px', paddingLeft: 18, fontSize: 11.5, color: 'var(--fl-put, #f5a623)' }
const th: CSSProperties = { textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--fl-border)', fontWeight: 600 }
const td: CSSProperties = { padding: '3px 8px', borderBottom: '1px solid var(--fl-border)', whiteSpace: 'nowrap' }
