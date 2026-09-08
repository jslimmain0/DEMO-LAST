import type { CSSProperties } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { HttpMethod, MockCond, MockExpect, MockExpectField, MockRouteSpec, MockRuleSpec, MockServerSpec } from '../api/types'
import type { SecretView } from '../api/client'
import { mocksApi } from '../api/client'
import { BindingPicker } from '../binding/BindingPicker'
import { TokenInput } from '../binding/TokenInput'
import type { BindableSource } from '../binding/upstream'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { bindingToToken } from '../lib/tokenGrammar'
import { expectKeys, insertAtCaret, mockSources, pathParamNames } from '../lib/mockSources'
import { newId } from '../lib/ids'
import { BigTextEditor, ExpandCorner } from './BigTextEditor'
import { DataInsertIcon } from './icons'
import { MockCodecEditor } from './MockCodecEditor'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']
const methodColor = (m: string): string => METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-cat-generic)'
const CONTENT_TYPES = ['json', 'text', 'html', 'xml', 'urlencoded']
const CHARSETS = ['UTF-8', 'EUC-KR', 'MS949']
const COND_SOURCES = ['body', 'query', 'header', 'path', 'state'] as const
const COND_OPS = ['eq', 'ne', 'exists', 'contains', 'gt', 'gte', 'lt', 'lte', 'regex', 'startswith', 'endswith'] as const

// ---------- 라우트 목록 ----------

export function RoutesEditor({ base, ensureSaved, mockId, spec, secrets, routes, onChange, readOnly, extraHeader }: {
  base: string; ensureSaved: () => Promise<boolean>; mockId: string; spec: MockServerSpec; secrets: SecretView[]
  routes: MockRouteSpec[]; onChange: (r: MockRouteSpec[]) => void; readOnly?: boolean; extraHeader?: React.ReactNode
}) {
  const setRoute = (i: number, r: MockRouteSpec) => onChange(routes.map((x, xi) => (xi === i ? r : x)))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= routes.length) return
    const next = [...routes]
    const t = next[i]; next[i] = next[j]; next[j] = t
    onChange(next)
  }
  const dup = (i: number) => {
    const src = routes[i]
    const copy: MockRouteSpec = { ...src, id: newId(), rules: src.rules.map((r) => ({ ...r, id: newId() })) }
    onChange([...routes.slice(0, i + 1), copy, ...routes.slice(i + 1)])
  }
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  // 라우트가 많을 때 메서드/경로로 좁혀 찾는다 — 원본 순서/인덱스는 유지(첫 매칭 의미 불변)
  const visible = routes.map((r, i) => ({ r, i })).filter(({ r }) => !f || `${r.method} ${r.path}`.toLowerCase().includes(f))
  return (
    <section style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <h2 style={h2}>라우트 <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>(위에서부터 첫 매칭)</span></h2>
        <span style={{ marginLeft: 'auto' }} />
        {extraHeader}
        {!readOnly && <button
          style={miniBtn}
          onClick={() => onChange([...routes, { id: newId(), method: 'GET', path: '/new', rules: [{ id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] }])}
        >+ 라우트 추가</button>}
      </div>
      <p style={hint}>
        경로는 <code style={code}>{'/users/{id}'}</code> 패턴 지원. 값 칸의 <code style={code}>{'{ }'}</code> 로 요청 값(예상 요청 필드)·상태·시크릿을 삽입합니다 —
        <code style={code}>{'{{ orderId@body }}'}</code> <code style={code}>{'{{ id@path }}'}</code> <code style={code}>{'{{ apiKey@secret }}'}</code> (기존 <code style={code}>{'{{body.x}}'}</code> 문법도 그대로).
        어떤 요청이 올지 모르면 라우트의 <b>예상 요청</b>에 미리 적거나, 실제 요청이 온 뒤 <b>요청 기록 → 예상 필드로</b>.
      </p>
      {routes.length === 0 && <p style={{ ...hint, padding: '14px 0' }}>라우트가 없습니다 — [+ 라우트 추가]로 시작하세요.</p>}
      {routes.length >= 5 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`라우트 검색 — 메서드/경로… (${routes.length}개)`} aria-label="라우트 검색"
          style={{ ...input, width: '100%', marginTop: 8, boxSizing: 'border-box' }} />
      )}
      {f && visible.length === 0 && routes.length > 0 && <p style={{ ...hint, padding: '10px 0' }}>검색과 일치하는 라우트가 없습니다.</p>}
      <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
        {visible.map(({ r, i }) => (
          <RouteCard
            key={r.id}
            base={base}
            ensureSaved={ensureSaved}
            mockId={mockId}
            spec={spec}
            secrets={secrets}
            route={r}
            readOnly={readOnly}
            onChange={(nr) => setRoute(i, nr)}
            onRemove={() => onChange(routes.filter((_, xi) => xi !== i))}
            onDup={() => dup(i)}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
          />
        ))}
      </div>
    </section>
  )
}

// ---------- 라우트 카드 ----------

function RouteCard({ base, ensureSaved, mockId, spec, secrets, route, readOnly, onChange, onRemove, onDup, onUp, onDown }: {
  base: string; ensureSaved: () => Promise<boolean>; mockId: string; spec: MockServerSpec; secrets: SecretView[]
  route: MockRouteSpec; readOnly?: boolean
  onChange: (r: MockRouteSpec) => void; onRemove: () => void; onDup: () => void; onUp: () => void; onDown: () => void
}) {
  const setRule = (i: number, u: MockRuleSpec) => onChange({ ...route, rules: route.rules.map((x, xi) => (xi === i ? u : x)) })
  const dupRule = (i: number) => {
    const copy = { ...route.rules[i], id: newId() }
    onChange({ ...route, rules: [...route.rules.slice(0, i + 1), copy, ...route.rules.slice(i + 1)] })
  }
  const sources = useMemo(() => mockSources({ spec, route, secrets, environment: spec.environment }), [spec, route, secrets])
  const [expectOpen, setExpectOpen] = useState(false)
  const [codecOpen, setCodecOpen] = useState(!!route.codec) // 이 라우트만 다른 전문 코덱(서버 codec 대체)
  // 이 라우트 원클릭 테스트 — 경로 파라미터/예상 요청 예시값으로 mock 에 실제 요청
  const [test, setTest] = useState<{ status: number; body: string; rule?: string | null } | string | null>(null)
  const [testing, setTesting] = useState(false)
  const runTest = async (rule?: MockRuleSpec) => {
    // 테스트는 저장된 mock 을 호출하므로 미저장 편집을 먼저 반영(아니면 stale 상태 테스트)
    if (!(await ensureSaved())) return
    setTesting(true); setTest(null)
    try {
      const req = buildSampleRequest(route, rule)
      const method = route.method === 'ANY' ? 'POST' : route.method
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const url = base + req.path + (req.query ? `?${req.query}` : '')
      const res = await fetch(url, { method, headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...req.headers }, body: hasBody ? req.body : undefined })
      const text = (await res.text()).slice(0, 2000)
      let matched: string | null | undefined
      if (rule) {
        try { const j = await mocksApi.requests(mockId); matched = j[0]?.matchedRuleId ?? null } catch { matched = undefined }
      }
      setTest({ status: res.status, body: text, rule: matched })
    } catch (e) { setTest(e instanceof Error ? e.message : String(e)) }
    finally { setTesting(false) }
  }
  const condCount = route.rules.reduce((a, r) => a + (r.when?.length ?? 0), 0)
  const badges: string[] = []
  if (route.expect && ((route.expect.body?.length ?? 0) + (route.expect.query?.length ?? 0) + (route.expect.header?.length ?? 0)) > 0) badges.push('예상 요청')
  if (condCount) badges.push(`조건 ${condCount}`)
  if (route.codec) badges.push('코덱')
  if (route.rules.some((r) => r.callback?.url)) badges.push('콜백')
  if (route.rules.some((r) => r.setState?.length)) badges.push('상태')
  if (route.rules.some((r) => r.repeat)) badges.push('N회')
  const fieldHints = { request: expectKeys(route, 'body'), response: [] as string[] }
  return (
    <div style={{ border: '1px solid var(--fl-border)', borderLeft: `3px solid ${methodColor(route.method)}`, borderRadius: 'var(--fl-radius)', padding: 14, background: 'var(--fl-surface)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...input, minWidth: 90 }} value={route.method} disabled={readOnly} onChange={(e) => onChange({ ...route, method: e.target.value })}>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input style={{ ...input, flex: 1, minWidth: 160, fontFamily: 'var(--fl-font-mono)' }} value={route.path} disabled={readOnly} onChange={(e) => onChange({ ...route, path: e.target.value })} placeholder="/users/{id}" />
        {badges.map((b) => <span key={b} style={badgeStyle}>{b}</span>)}
        <button style={{ ...miniBtn, color: 'var(--fl-primary)' }} onClick={() => { void runTest() }} disabled={testing} title="예상 요청 예시값으로 이 라우트에 바로 요청을 보내 응답을 봅니다">{testing ? '…' : '▶ 테스트'}</button>
        {!readOnly && <>
          <button style={miniBtn} onClick={onDup} title="라우트 복제">복제</button>
          <button style={miniBtn} onClick={onUp} title="위로">↑</button>
          <button style={miniBtn} onClick={onDown} title="아래로">↓</button>
          <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onRemove}>삭제</button>
        </>}
      </div>
      {test != null && (
        <div style={{ marginTop: 8, border: `1px solid ${typeof test === 'string' ? 'var(--fl-fail)' : 'var(--fl-border)'}`, borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }}>
          {typeof test === 'string'
            ? <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--fl-fail)' }}>{test}</div>
            : <><div style={{ padding: '5px 10px', fontSize: 12, fontWeight: 600, background: 'var(--fl-surface-2)', color: test.status < 400 ? 'var(--fl-ok)' : 'var(--fl-fail)', display: 'flex', gap: 10 }}>
                  <span>HTTP {test.status}</span>
                  {test.rule !== undefined && <span style={{ color: 'var(--fl-text-muted)', fontWeight: 500 }}>매칭 규칙: {test.rule ? `규칙 ${route.rules.findIndex((r) => r.id === test.rule) + 1}` : '없음'}</span>}
                </div>
                <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto', color: 'var(--fl-text)' }}>{test.body}</pre></>}
        </div>
      )}

      {/* 예상 요청 — 어떤 요청이 올지 미리 정의(피커 소스·조건 키·테스트 샘플). 요청 기록에서 자동 채움. */}
      <div style={{ marginTop: 10 }}>
        <button style={{ ...miniBtn, fontWeight: 700 }} onClick={() => setExpectOpen((v) => !v)}>{expectOpen ? '▾' : '▸'} 예상 요청 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}>{expectSummary(route)}</span></button>
        {expectOpen && <ExpectEditor route={route} readOnly={readOnly} onChange={(expect) => onChange({ ...route, expect })} />}
      </div>

      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        {route.rules.map((u, i) => (
          <RuleCard
            key={u.id}
            rule={u}
            index={i}
            total={route.rules.length}
            route={route}
            sources={sources}
            readOnly={readOnly}
            onChange={(nu) => setRule(i, nu)}
            onDup={() => dupRule(i)}
            onRemove={() => onChange({ ...route, rules: route.rules.filter((_, xi) => xi !== i) })}
            onTest={() => { void runTest(u) }}
            testing={testing}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        {!readOnly && <button
          style={miniBtn}
          onClick={() => onChange({ ...route, rules: [...route.rules, { id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] })}
        >+ 규칙 추가</button>}
        <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', marginLeft: 'auto', color: route.codec ? 'var(--fl-primary)' : 'var(--fl-text-muted)' }} title="서버 전문 코덱 대신 이 라우트만 다른 플러그인 단계를 적용">
          <input type="checkbox" checked={codecOpen} disabled={readOnly} onChange={(e) => { setCodecOpen(e.target.checked); if (!e.target.checked) onChange({ ...route, codec: null }) }} />
          이 라우트만 코덱
        </label>
      </div>
      {codecOpen && (
        <div style={{ marginTop: 8, padding: 10, border: '1px dashed var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 6 }}>이 라우트에는 서버 코덱 대신 아래 단계만 적용됩니다(통째로 대체 — 비우면 코덱 없음).</div>
          <MockCodecEditor compact kind="http" codec={route.codec} readOnly={readOnly} sources={sources} fieldHints={fieldHints} mockId={mockId} environment={spec.environment}
            onChange={(codec) => onChange({ ...route, codec: codec ?? { } })} />
        </div>
      )}
    </div>
  )
}

function expectSummary(route: MockRouteSpec): string {
  const b = route.expect?.body?.length ?? 0, q = route.expect?.query?.length ?? 0, h = route.expect?.header?.length ?? 0, p = pathParamNames(route.path).length
  const parts: string[] = []
  if (p) parts.push(`경로 ${p}`); if (q) parts.push(`쿼리 ${q}`); if (h) parts.push(`헤더 ${h}`); if (b) parts.push(`본문 ${b}`)
  return parts.length ? `(${parts.join(' · ')})` : '(없음 — 요청 기록에서 채우거나 직접 입력)'
}

/** 예상 요청 편집 — 본문/쿼리/헤더 키 + 예시값(테스트 요청에 쓰임). */
function ExpectEditor({ route, readOnly, onChange }: { route: MockRouteSpec; readOnly?: boolean; onChange: (e: MockExpect) => void }) {
  const ex = route.expect ?? {}
  const section = (title: string, key: 'body' | 'query' | 'header', placeholder: string) => {
    const rows = ex[key] ?? []
    const set = (rows2: MockExpectField[]) => onChange({ ...ex, [key]: rows2 })
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)' }}>{title}</span>
          {!readOnly && <button style={{ ...miniBtn, padding: '2px 8px' }} onClick={() => set([...rows, { key: '', example: '' }])}>+ 키</button>}
        </div>
        {rows.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={f.key} placeholder={placeholder} disabled={readOnly} onChange={(e) => set(rows.map((x, xi) => (xi === i ? { ...x, key: e.target.value } : x)))} />
            <input style={{ ...input, flex: 1.2, fontFamily: 'var(--fl-font-mono)' }} value={f.example ?? ''} placeholder="예시값(테스트 요청에 사용)" disabled={readOnly} onChange={(e) => set(rows.map((x, xi) => (xi === i ? { ...x, example: e.target.value } : x)))} />
            {!readOnly && <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => set(rows.filter((_, xi) => xi !== i))} aria-label="예상 필드 삭제">×</button>}
          </div>
        ))}
        {rows.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginBottom: 4 }}>없음</div>}
      </div>
    )
  }
  const pp = pathParamNames(route.path)
  return (
    <div style={{ marginTop: 6, padding: 10, border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', display: 'grid', gap: 8, background: 'var(--fl-surface-2)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>이 라우트로 올 요청의 필드를 적어 두면 값 칸의 <code style={code}>{'{ }'}</code> 피커·조건 키 후보·▶ 테스트 샘플에 쓰입니다. 실제 요청이 오면 <b>요청 기록 → 예상 필드로</b>가 자동으로 채웁니다.{pp.length ? ` 경로 파라미터: ${pp.join(', ')}` : ''}</div>
      {section('본문 필드 (JSON 최상위 / urlencoded 키)', 'body', '예: orderId')}
      {section('쿼리', 'query', '예: page')}
      {section('헤더', 'header', '예: Authorization')}
    </div>
  )
}

/** 테스트 요청 조립 — 예상 요청 예시값 + (규칙 테스트면) 그 규칙의 eq 조건값을 덮어씀. */
function buildSampleRequest(route: MockRouteSpec, rule?: MockRuleSpec): { path: string; query: string; headers: Record<string, string>; body: string } {
  const pathVals: Record<string, string> = {}
  for (const p of pathParamNames(route.path)) pathVals[p] = '1'
  const body: Record<string, string> = {}
  for (const f of route.expect?.body ?? []) if (f.key?.trim()) body[f.key.trim()] = f.example ?? ''
  const query: Record<string, string> = {}
  for (const f of route.expect?.query ?? []) if (f.key?.trim()) query[f.key.trim()] = f.example ?? ''
  const headers: Record<string, string> = {}
  for (const f of route.expect?.header ?? []) if (f.key?.trim() && f.example) headers[f.key.trim()] = f.example
  for (const c of rule?.when ?? []) {
    if (!c.key || c.op !== 'eq') continue
    const v = c.value ?? ''
    if (c.source === 'body') body[c.key] = v
    else if (c.source === 'query') query[c.key] = v
    else if (c.source === 'header') headers[c.key] = v
    else if (c.source === 'path') pathVals[c.key] = v
  }
  const path = route.path.replace(/\{([^}/]+)\}/g, (_, k: string) => encodeURIComponent(pathVals[k] ?? '1'))
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return { path, query: qs, headers, body: Object.keys(body).length ? JSON.stringify(body) : '{}' }
}

// ---------- 규칙 카드 ----------

function RuleCard({ rule, index, total, route, sources, readOnly, onChange, onDup, onRemove, onTest, testing }: {
  rule: MockRuleSpec; index: number; total: number; route: MockRouteSpec; sources: BindableSource[]; readOnly?: boolean
  onChange: (u: MockRuleSpec) => void; onDup: () => void; onRemove: () => void; onTest: () => void; testing: boolean
}) {
  const [showCb, setShowCb] = useState(!!rule.callback?.url)
  const [big, setBig] = useState<'body' | 'cb' | null>(null) // HTML 템플릿 등 긴 본문 — 거의 전체화면 편집
  const [pick, setPick] = useState<'body' | 'cb' | null>(null) // 여러 줄 본문의 { } 데이터 삽입
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const cbRef = useRef<HTMLTextAreaElement>(null)
  const conds = rule.when ?? []
  const setCond = (i: number, c: MockCond) => onChange({ ...rule, when: conds.map((x, xi) => (xi === i ? c : x)) })
  const cb = rule.callback ?? {}
  const setCb = (patch: Partial<typeof cb>) => onChange({ ...rule, callback: { ...cb, ...patch } })
  const headers = rule.headers ?? []
  const condListId = (i: number) => `cond-keys-${rule.id}-${i}`
  return (
    <div style={{ border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)' }}>
          규칙 {index + 1}/{total} {conds.length === 0 && '(조건 없음 = 기본)'}
        </span>
        <span style={{ fontSize: 12, marginLeft: 'auto' }}>status</span>
        <input style={{ ...input, width: 72, fontFamily: 'var(--fl-font-mono)' }} value={rule.status ?? 200} disabled={readOnly} onChange={(e) => onChange({ ...rule, status: Number(e.target.value) || 200 })} />
        <select style={{ ...input, minWidth: 100 }} value={rule.contentType ?? 'json'} disabled={readOnly} onChange={(e) => onChange({ ...rule, contentType: e.target.value })}>
          {CONTENT_TYPES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select style={{ ...input, minWidth: 90 }} value={rule.charset ?? 'UTF-8'} disabled={readOnly} onChange={(e) => onChange({ ...rule, charset: e.target.value })}>
          {CHARSETS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <span style={{ fontSize: 12 }}>지연(ms)</span>
        <input style={{ ...input, width: 76, fontFamily: 'var(--fl-font-mono)' }} value={rule.delayMs ?? 0} disabled={readOnly} onChange={(e) => onChange({ ...rule, delayMs: Number(e.target.value) || 0 })} />
        <span style={{ fontSize: 12 }} title="이 규칙을 처음 N회 매칭까지만 적용(순차 응답). 비우면 무제한">N회만</span>
        <input style={{ ...input, width: 56, fontFamily: 'var(--fl-font-mono)' }} value={rule.repeat ?? ''} placeholder="∞" disabled={readOnly}
          onChange={(e) => { const n = Number(e.target.value); onChange({ ...rule, repeat: e.target.value.trim() && n > 0 ? n : undefined }) }} />
        <button style={{ ...miniBtn, color: 'var(--fl-primary)' }} onClick={onTest} disabled={testing} title="이 규칙의 조건(eq)값 + 예상 요청 예시로 요청을 보내 이 규칙이 매칭되는지 확인">▶ 규칙 테스트</button>
        {!readOnly && <>
          <button style={miniBtn} onClick={onDup} title="규칙 복제">복제</button>
          <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onRemove}>규칙 삭제</button>
        </>}
      </div>

      {/* 조건 — 키는 예상 요청 필드에서 후보 제시(자유 입력 가능) */}
      <div style={{ marginTop: 8 }}>
        {conds.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <select style={{ ...input, minWidth: 86 }} value={c.source} disabled={readOnly} onChange={(e) => setCond(i, { ...c, source: e.target.value as MockCond['source'] })}>
              {COND_SOURCES.map((s) => <option key={s}>{s}</option>)}
            </select>
            <input list={condListId(i)} style={{ ...input, width: 150, fontFamily: 'var(--fl-font-mono)' }} value={c.key} placeholder="키" disabled={readOnly} onChange={(e) => setCond(i, { ...c, key: e.target.value })} />
            <datalist id={condListId(i)}>{(c.source === 'state' ? (sources.find((s) => s.id === 'state')?.items.map((it) => it.key) ?? []) : expectKeys(route, c.source as 'body' | 'query' | 'header' | 'path')).map((k) => <option key={k} value={k} />)}</datalist>
            <select style={{ ...input, minWidth: 92 }} value={c.op} disabled={readOnly} onChange={(e) => setCond(i, { ...c, op: e.target.value as MockCond['op'] })}>
              {COND_OPS.map((o) => <option key={o}>{o}</option>)}
            </select>
            {c.op !== 'exists' && (
              <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={c.value ?? ''} placeholder="값" disabled={readOnly} onChange={(e) => setCond(i, { ...c, value: e.target.value })} />
            )}
            {!readOnly && <button style={miniBtn} onClick={() => onChange({ ...rule, when: conds.filter((_, xi) => xi !== i) })}>×</button>}
          </div>
        ))}
        {!readOnly && <button
          style={{ ...miniBtn, marginTop: 6 }}
          onClick={() => onChange({ ...rule, when: [...conds, { source: 'body', key: expectKeys(route, 'body')[0] ?? '', op: 'eq', value: '' }] })}
        >+ 조건 (요청 값으로 분기)</button>}
      </div>

      {/* 본문 — HTML(결제창) 같은 긴 템플릿은 ⤢ 로 거의 전체화면 편집, { } 로 요청 값/시크릿 삽입 */}
      <div style={{ position: 'relative', marginTop: 8 }}>
        <textarea
          ref={bodyRef}
          style={{ ...input, width: '100%', minHeight: 74, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box', paddingRight: 64 }}
          value={rule.body ?? ''}
          disabled={readOnly}
          placeholder={'응답 본문 — 예: {"orderId":"{{ orderId@body }}","status":"{{ status@state }}"}'}
          onChange={(e) => onChange({ ...rule, body: e.target.value })}
        />
        {!readOnly && sources.length > 0 && (
          <button onClick={() => setPick('body')} title="데이터 삽입(요청 값·상태·시크릿)" aria-label="본문 데이터 삽입" style={{ ...braceBtn, position: 'absolute', right: 34, top: 6 }}><DataInsertIcon /></button>
        )}
        <ExpandCorner onClick={() => setBig('body')} label="응답 본문 크게 편집" />
      </div>

      {/* 응답 헤더 — 값은 템플릿(칩). 응답 후 코덱의 header 대상과 조합(서명 등) */}
      <div style={{ marginTop: 8 }}>
        {headers.map((h, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
            <input style={{ ...input, width: 170, fontFamily: 'var(--fl-font-mono)' }} value={h.key} placeholder="헤더명 (예: X-Request-Id)" disabled={readOnly} onChange={(e) => onChange({ ...rule, headers: headers.map((x, xi) => (xi === i ? { ...x, key: e.target.value } : x)) })} />
            <div style={{ flex: 1 }}><TokenInput ariaLabel={`응답 헤더 ${h.key}`} value={h.value} sources={sources} placeholder="값 또는 { } 데이터 삽입" onChange={(v) => onChange({ ...rule, headers: headers.map((x, xi) => (xi === i ? { ...x, value: v } : x)) })} /></div>
            {!readOnly && <button style={miniBtn} onClick={() => onChange({ ...rule, headers: headers.filter((_, xi) => xi !== i) })}>×</button>}
          </div>
        ))}
        {!readOnly && <button style={miniBtn} onClick={() => onChange({ ...rule, headers: [...headers, { key: '', value: '' }] })}>+ 응답 헤더</button>}
      </div>

      {/* 상태 설정(setState) — 상태 있는 목: 응답 후 서버 상태 갱신 → 다음 호출 조건(source=state)/템플릿({{state.x}}) */}
      <div style={{ marginTop: 8 }}>
        {(rule.setState ?? []).map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>state.</span>
            <input style={{ ...input, flex: 1 }} value={s.key} placeholder="키(예: status)" disabled={readOnly} onChange={(e) => onChange({ ...rule, setState: (rule.setState ?? []).map((x, xi) => xi === i ? { ...x, key: e.target.value } : x) })} />
            <select style={{ ...input, width: 78 }} value={s.op ?? 'set'} title="대입/증가/감소(증감은 숫자 누산기)" disabled={readOnly} onChange={(e) => onChange({ ...rule, setState: (rule.setState ?? []).map((x, xi) => xi === i ? { ...x, op: e.target.value as 'set' | 'incr' | 'decr' } : x) })}>
              <option value="set">대입</option><option value="incr">증가</option><option value="decr">감소</option>
            </select>
            <div style={{ flex: 1.4 }}><TokenInput ariaLabel={`상태 ${s.key} 값`} value={s.value} sources={sources} placeholder={s.op === 'incr' || s.op === 'decr' ? '증감량(기본 1)' : '값(템플릿, 예: approved)'} onChange={(v) => onChange({ ...rule, setState: (rule.setState ?? []).map((x, xi) => xi === i ? { ...x, value: v } : x) })} /></div>
            {!readOnly && <button style={miniBtn} onClick={() => onChange({ ...rule, setState: (rule.setState ?? []).filter((_, xi) => xi !== i) })}>×</button>}
          </div>
        ))}
        {!readOnly && <button style={miniBtn} onClick={() => onChange({ ...rule, setState: [...(rule.setState ?? []), { key: '', value: '' }] })}>+ 상태 설정 (호출 후 저장 · 다음 호출에 {'{{ 키@state }}'}로 보임)</button>}
      </div>

      {/* 콜백 발사 */}
      <div style={{ marginTop: 8 }}>
        <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={showCb} disabled={readOnly} onChange={(e) => { setShowCb(e.target.checked); if (!e.target.checked) onChange({ ...rule, callback: null }) }} />
          응답 후 콜백(웹훅) 발사 — 승인·입금 알림 콜백 패턴
        </label>
        {showCb && (
          <div style={{ display: 'grid', gap: 6, marginTop: 6, paddingLeft: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, flexShrink: 0 }}>지연(ms)</span>
              <input style={{ ...input, width: 90, fontFamily: 'var(--fl-font-mono)' }} value={cb.afterMs ?? 500} disabled={readOnly} onChange={(e) => setCb({ afterMs: Number(e.target.value) || 0 })} />
              <div style={{ flex: 1 }}><TokenInput ariaLabel="콜백 URL" value={cb.url ?? ''} sources={sources} placeholder="URL 템플릿 — 예: {{ notiUrl@body }}" onChange={(v) => setCb({ url: v })} /></div>
              <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={cb.retryUntilOk ?? true} disabled={readOnly} onChange={(e) => setCb({ retryUntilOk: e.target.checked })} />
                OK 재시도
              </label>
            </div>
            <div style={{ position: 'relative' }}>
              <textarea
                ref={cbRef}
                style={{ ...input, width: '100%', minHeight: 46, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box', paddingRight: 64 }}
                value={cb.body ?? ''}
                disabled={readOnly}
                placeholder="콜백 본문(urlencoded) — 예: resultCode=0000&orderId={{ orderId@body }}"
                onChange={(e) => setCb({ body: e.target.value })}
              />
              {!readOnly && sources.length > 0 && (
                <button onClick={() => setPick('cb')} title="데이터 삽입" aria-label="콜백 본문 데이터 삽입" style={{ ...braceBtn, position: 'absolute', right: 34, top: 6 }}><DataInsertIcon /></button>
              )}
              <ExpandCorner onClick={() => setBig('cb')} label="콜백 본문 크게 편집" />
            </div>
          </div>
        )}
      </div>

      {pick && (
        <BindingPicker
          sources={sources}
          onClose={() => setPick(null)}
          onPick={(b) => {
            const token = bindingToToken(b)
            if (pick === 'body') onChange({ ...rule, body: insertAtCaret(bodyRef.current, rule.body ?? '', token) })
            else setCb({ body: insertAtCaret(cbRef.current, cb.body ?? '', token) })
            setPick(null)
          }}
        />
      )}
      {big === 'body' && (
        <BigTextEditor
          title={`규칙 ${index + 1}/${total} — 응답 본문 크게 편집`}
          value={rule.body ?? ''}
          onChange={(v) => onChange({ ...rule, body: v })}
          onClose={() => setBig(null)}
          language={rule.contentType === 'html' ? 'html' : rule.contentType === 'json' ? 'json' : rule.contentType === 'xml' ? 'xml' : 'auto'}
          placeholder={'응답 본문 템플릿 — HTML/JSON. 예: {{ id@path }} {{ q@query }} {{ 필드@body }} {{ x@state }} {{ uuid }} {{ now }}'}
          hint="입력 즉시 반영됩니다(Esc 로 닫기). contentType 이 html 이면 브라우저에 페이지로 렌더됩니다 — 결제창/인증창 패턴. {{템플릿}} 토큰이 문법 경고로 표시될 수 있습니다(무해)."
        />
      )}
      {big === 'cb' && (
        <BigTextEditor
          title={`규칙 ${index + 1}/${total} — 콜백 본문 크게 편집`}
          value={cb.body ?? ''}
          onChange={(v) => setCb({ body: v })}
          onClose={() => setBig(null)}
          language="text"
          placeholder="resultCode=0000&orderId={{ orderId@body }}"
          hint="응답 후 발사되는 콜백(웹훅)의 본문(urlencoded) — 템플릿 문법 동일."
        />
      )}
    </div>
  )
}

// ---------- 스타일 ----------

const panel: CSSProperties = { marginTop: 22, padding: 18, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const h2: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const input: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13 }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const braceBtn: CSSProperties = { width: 26, height: 24, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0 }
const badgeStyle: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)' }
