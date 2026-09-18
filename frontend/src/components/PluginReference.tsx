// 스크립트 플러그인 레퍼런스 — 편집기 오른쪽 탭. 위: 플러그인 객체 모양(kind 별) · 아래: fl.* 함수 목록(매니페스트 = 자동완성과 같은 원천), 검색, 클릭하면 예제를 커서에 삽입.
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import type { FlApiEntry, PluginKind } from '../api/types'

const SHAPE: Record<PluginKind, { title: string; code: string; note: string }> = {
  transform: {
    title: '변환 — TRANSFORM 노드 · Mock 코덱 단계',
    code: `({
  id: 'my-id',            // 소문자·숫자·하이픈, 저장 후 변경 불가
  label: '이름', description: '한 줄',
  inputs:  [{ key: 'input', label: '원문' }],
  outputs: [{ key: 'result', label: '결과', type: 'string' }],
  params:  [{ key: 'key', label: '키', placeholder: '{{ k@secret }}' }],
  apply(inputs, config) {
    return { result: /* … */ }
  },
})`,
    note: 'outputs.type: string | number | boolean | json | array — 다운스트림에 그 타입으로 전달',
  },
  fieldCodec: {
    title: '필드 코덱 — 프로토콜 필드 plugin · Mock 코덱 fields',
    code: `({
  id: 'my-id', label: '이름', kind: 'fieldCodec',
  params: [{ key: 'key', label: '키' }],
  encode(value, ctx) { return /* 보낼 때: 문자열 */ },
  decode(value, ctx) { return /* 받을 때: 문자열 */ },
})`,
    note: 'encode = 송신 전(문자셋 인코딩 전) · decode = 수신 후(패딩 제거 후)',
  },
  messageCodec: {
    title: '전문 코덱 — 본문 bytes 전체(헤더는 평문)',
    code: `({
  id: 'my-id', label: '이름', kind: 'messageCodec',
  params: [{ key: 'key', label: '키' }],
  encode(body, ctx) { return /* Uint8Array */ },
  decode(body, ctx) { return /* Uint8Array */ },
})`,
    note: '길이 계산 전에 적용 — 암호화로 길이가 바뀌어도 헤더 길이는 맞는다',
  },
}

const COMMON = [
  ['params', "[{ key, label, type?: 'string'|'number'|'select'|'textarea', options?, defaultValue?, placeholder? }] → 설정 폼, config 로 전달. 시크릿은 {{ name@secret }}"],
  ['ctx', "{ config, direction: 'send'|'recv', field: { name, len, type, pad } | null, message: { 필드: 값 } }"],
  ['규칙', '순수 함수 — 파일·네트워크·Java 없음, fl.* + 표준 JS 만. 호출당 시간 상한(기본 2초). fl.log() 는 실행 패널 콘솔'],
] as const

export function PluginReference({ manifest, source, onInsert }: { manifest: FlApiEntry[]; source: string; onInsert: (text: string) => void }) {
  const [q, setQ] = useState('')
  const kind: PluginKind = /kind\s*:\s*['"]messageCodec['"]/.test(source) ? 'messageCodec' : /kind\s*:\s*['"]fieldCodec['"]/.test(source) ? 'fieldCodec' : 'transform'
  const shape = SHAPE[kind]
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase()
    const hit = manifest.filter((e) => !t || `${e.path} ${e.doc} ${e.signature}`.toLowerCase().includes(t))
    const m = new Map<string, FlApiEntry[]>()
    for (const e of hit) { const ns = e.path.split('.').slice(0, -1).join('.'); (m.get(ns) ?? m.set(ns, []).get(ns)!).push(e) }
    return [...m.entries()]
  }, [manifest, q])
  return (
    <aside style={panel} aria-label="레퍼런스">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="fl 함수 검색 — des, base64, 패딩…" aria-label="레퍼런스 검색" style={search} />
      {!q && (
        <section style={{ display: 'grid', gap: 6 }}>
          <strong style={{ fontSize: 12.5 }}>{shape.title}</strong>
          <pre style={code}>{shape.code}</pre>
          <div style={note}>{shape.note}</div>
          {COMMON.map(([k, v]) => <div key={k} style={note}><b style={{ color: 'var(--fl-text)' }}>{k}</b> · {v}</div>)}
        </section>
      )}
      <section style={{ display: 'grid', gap: 4 }}>
        <strong style={{ fontSize: 12.5 }}>fl.* 함수 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}>— 클릭하면 예제를 커서에 삽입</span></strong>
        {!groups.length && <div style={note}>일치하는 함수가 없습니다.</div>}
        {groups.map(([ns, es]) => (
          <div key={ns} style={{ display: 'grid', gap: 2 }}>
            <div style={{ fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', marginTop: 4 }}>{ns}</div>
            {es.map((e) => (
              <button key={e.path} onClick={() => onInsert(e.example)} title={e.signature} style={row}>
                <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--fl-primary)' }}>{e.path.slice(3)}</span>
                <span style={{ fontSize: 11.5, color: 'var(--fl-text)' }}>{e.doc}</span>
                <code style={{ fontSize: 11, color: 'var(--fl-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{e.signature}</code>
              </button>
            ))}
          </div>
        ))}
      </section>
    </aside>
  )
}

const panel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, padding: 14, overflowY: 'auto', background: 'var(--fl-surface)', minHeight: 0 }
const search: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5, flexShrink: 0 }
const code: CSSProperties = { margin: 0, padding: 10, fontSize: 11.5, lineHeight: 1.45, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflowX: 'auto', whiteSpace: 'pre' }
const note: CSSProperties = { fontSize: 11.5, lineHeight: 1.5, color: 'var(--fl-text-muted)' }
const row: CSSProperties = { display: 'grid', gap: 2, textAlign: 'left', padding: '6px 8px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', cursor: 'pointer', minWidth: 0 }
