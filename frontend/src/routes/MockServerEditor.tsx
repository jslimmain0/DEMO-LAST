import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { HttpMethod, MockCond, MockRouteSpec, MockRuleSpec, MockServerSpec, MockTcpRuleSpec, MockTcpSpec } from '../api/types'
import { mockBaseUrl, mocksApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { useReadableInk } from '../lib/contrast'
import { newId } from '../lib/ids'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']
// 라우트 카드 좌측 스파인 색 — 캔버스 MethodTag 와 같은 어휘. ANY 등 미지원 메서드는 중립색.
const methodColor = (m: string): string => METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-cat-generic)'
const CONTENT_TYPES = ['json', 'text', 'html', 'xml', 'urlencoded']
const CHARSETS = ['UTF-8', 'EUC-KR', 'MS949']
const COND_SOURCES = ['body', 'query', 'header', 'path', 'state'] as const
const COND_OPS = ['eq', 'ne', 'exists', 'contains'] as const

/** Mock 서버 편집기 — 경로별 라우트/규칙(응답 템플릿·조건·콜백)을 정의하고 바로 보내본다. */
export function MockServerEditor() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const { canEdit } = usePermissions()
  const { me } = useAuth()
  const badgeInk = useReadableInk('var(--fl-cat-generic)')
  const detail = useQuery({ queryKey: ['mock-server', id], queryFn: () => mocksApi.get(id), enabled: !!id })

  const [spec, setSpec] = useState<MockServerSpec>({ routes: [] })
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['mock-server', id] })
    void qc.invalidateQueries({ queryKey: ['mock-servers'] })
  }

  useEffect(() => {
    if (detail.data) {
      setSpec(detail.data.spec ?? { routes: [] })
      setName(detail.data.name)
      setDirty(false)
    }
  }, [detail.data])

  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() && name.trim() !== detail.data?.name) {
        await mocksApi.update(id, { name: name.trim() })
      }
      return mocksApi.updateSpec(id, spec)
    },
    onSuccess: () => {
      setDirty(false)
      setNote('저장됨 — 즉시 서빙에 반영됩니다.')
      invalidate()
    },
    onError: (e) => setNote(apiErrorMessage(e, '저장에 실패했습니다')),
  })
  const toggle = useMutation({
    mutationFn: () => mocksApi.update(id, { enabled: !detail.data?.enabled }),
    onSuccess: invalidate,
  })

  const mutate = (fn: (s: MockServerSpec) => MockServerSpec) => {
    setSpec((s) => fn(s))
    setDirty(true)
    setNote(null)
  }

  const d = detail.data
  const base = d ? mockBaseUrl(d.slug, me?.tenant) : ''

  // 테스트는 저장된 mock 을 호출하므로, 미저장 편집이 있으면 먼저 저장(권한 없으면 거절)
  const ensureSaved = async (): Promise<boolean> => {
    if (!dirty) return true
    if (!canEdit) { toast('미저장 편집이 있습니다 — 먼저 저장하세요(테스트는 저장된 mock 을 호출합니다).', 'error'); return false }
    try { await save.mutateAsync(); return true } catch { toast('저장 실패 — 미저장 편집을 반영하지 못했습니다.', 'error'); return false }
  }

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: '24px 24px 60px' }}>
        {!d ? (
          <p style={{ color: 'var(--fl-text-muted)' }}>불러오는 중…</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Link to="/mocks" style={{ color: 'var(--fl-text-muted)', textDecoration: 'none', fontSize: 13 }}>← Mock 서버</Link>
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setDirty(true) }}
                style={{ ...input, fontSize: 17, fontWeight: 700, minWidth: 240 }}
                aria-label="이름"
              />
              <span style={{ ...badge, background: 'var(--fl-cat-generic)', color: badgeInk }}>Mock</span>
              <button
                style={{ ...miniBtn, color: d.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', opacity: canEdit ? 1 : 0.5 }}
                disabled={!canEdit}
                title={canEdit ? undefined : 'viewer 역할은 변경할 수 없습니다'}
                onClick={() => toggle.mutate()}
              >
                {d.enabled ? '● 서빙 중' : '○ 꺼짐'}
              </button>
              <button style={{ ...primaryBtn, marginLeft: 'auto', opacity: dirty && canEdit ? 1 : 0.55 }} disabled={!dirty || save.isPending || !canEdit} title={canEdit ? undefined : 'viewer 역할은 저장할 수 없습니다'} onClick={() => save.mutate()}>
                저장
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)', flexShrink: 0 }}>base URL:</span>
              <input readOnly value={base} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} />
              <button style={miniBtn} onClick={() => { void navigator.clipboard?.writeText(base).catch(() => {}) }}>⧉ 복사</button>
            </div>
            {note && <p style={{ fontSize: 12.5, marginTop: 8, color: note.startsWith('저장됨') ? 'var(--fl-ok)' : 'var(--fl-fail)' }}>{note}</p>}

            <RoutesEditor
              base={base}
              ensureSaved={ensureSaved}
              routes={spec.routes ?? []}
              onChange={(routes) => mutate((s) => ({ ...s, routes }))}
            />

            <TcpEditor
              tcp={spec.tcp ?? null}
              onChange={(tcp) => mutate((s) => ({ ...s, tcp }))}
            />

            <TestPanel base={base} ensureSaved={ensureSaved} />
          </>
        )}
      </div>
    </AppShellTier1>
  )
}

// ---------- 커스텀 라우트 편집 ----------

// OpenAPI/Swagger 문서(JSON) → mock 라우트. path+method 마다 첫 성공 응답 코드와 예시 본문으로 규칙 1개 생성.
function openApiToMockRoutes(text: string): MockRouteSpec[] {
  let doc: Record<string, unknown>
  try { doc = JSON.parse(text) } catch { return [] }
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined
  if (!paths || typeof paths !== 'object') return []
  const out: MockRouteSpec[] = []
  const METHODS_L = ['get', 'post', 'put', 'patch', 'delete', 'head']
  for (const [path, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue
    for (const m of METHODS_L) {
      const op = ops[m] as Record<string, unknown> | undefined
      if (!op) continue
      const responses = (op.responses ?? {}) as Record<string, unknown>
      const codes = Object.keys(responses)
      const okCode = codes.find((c) => c.startsWith('2')) ?? codes[0] ?? 'default'
      const status = /^\d+$/.test(okCode) ? Number(okCode) : 200
      // 예시 응답: responses[code].content['application/json'].example / schema.example, 없으면 {}
      let body = '{}'
      try {
        const resp = responses[okCode] as Record<string, unknown> | undefined
        const content = (resp?.content ?? {}) as Record<string, { example?: unknown; schema?: { example?: unknown } }>
        const jsonCt = Object.keys(content).find((k) => k.includes('json'))
        const ex = jsonCt ? (content[jsonCt].example ?? content[jsonCt].schema?.example) : (resp?.example ?? (resp?.examples as Record<string, { value?: unknown }> | undefined)?.[Object.keys((resp?.examples as object) ?? {})[0]]?.value)
        if (ex !== undefined) body = JSON.stringify(ex, null, 2)
      } catch { /* 예시 없으면 {} */ }
      out.push({ id: newId(), method: m.toUpperCase(), path: String(path), rules: [{ id: newId(), status, contentType: 'json', body }] })
    }
  }
  return out
}

function RoutesEditor({ base, ensureSaved, routes, onChange }: { base: string; ensureSaved: () => Promise<boolean>; routes: MockRouteSpec[]; onChange: (r: MockRouteSpec[]) => void }) {
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
  const [openApi, setOpenApi] = useState<string | null>(null)
  return (
    <section style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <h2 style={h2}>라우트 <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>(위에서부터 첫 매칭)</span></h2>
        <button style={{ ...miniBtn, marginLeft: 'auto' }} onClick={() => setOpenApi(openApi === null ? '' : null)} title="OpenAPI/Swagger 문서를 붙여넣어 라우트 자동 생성">OpenAPI 가져오기</button>
        <button
          style={miniBtn}
          onClick={() => onChange([...routes, { id: newId(), method: 'GET', path: '/new', rules: [{ id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] }])}
        >+ 라우트 추가</button>
      </div>
      {openApi !== null && (
        <div style={{ margin: '8px 0' }}>
          <textarea autoFocus value={openApi} onChange={(e) => setOpenApi(e.target.value)} placeholder="OpenAPI 3 / Swagger 2 JSON 을 붙여넣으세요…"
            style={{ ...input, width: '100%', minHeight: 90, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button style={{ ...miniBtn, color: 'var(--fl-primary)' }} onClick={() => {
              const generated = openApiToMockRoutes(openApi)
              if (!generated.length) { toast('라우트를 추출하지 못했습니다 — 유효한 OpenAPI/Swagger JSON 인지 확인하세요.', 'error'); return }
              onChange([...routes, ...generated])
              setOpenApi(null)
              toast(`라우트 ${generated.length}개를 생성했습니다.`, 'ok')
            }}>가져오기</button>
            <button style={miniBtn} onClick={() => setOpenApi(null)}>취소</button>
          </div>
        </div>
      )}
      <p style={hint}>
        경로는 <code style={code}>{'/users/{id}'}</code> 패턴 지원. 응답 본문·헤더·콜백은 템플릿을 쓸 수 있습니다:
        <code style={code}>{'{{path.id}} {{query.q}} {{body.필드}} {{header.이름}} {{body}} {{uuid}} {{seq}} {{now}}'}</code>
        (워크플로의 <code style={code}>{'{{ 키@노드 }}'}</code> 바인딩과는 다른 문법입니다)
      </p>
      {routes.length === 0 && <p style={{ ...hint, padding: '14px 0' }}>라우트가 없습니다 — [+ 라우트 추가]로 시작하세요.</p>}
      <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
        {routes.map((r, i) => (
          <RouteCard
            key={r.id}
            base={base}
            ensureSaved={ensureSaved}
            route={r}
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

function RouteCard({ base, ensureSaved, route, onChange, onRemove, onDup, onUp, onDown }: {
  base: string
  ensureSaved: () => Promise<boolean>
  route: MockRouteSpec
  onChange: (r: MockRouteSpec) => void
  onRemove: () => void
  onDup: () => void
  onUp: () => void
  onDown: () => void
}) {
  const setRule = (i: number, u: MockRuleSpec) => onChange({ ...route, rules: route.rules.map((x, xi) => (xi === i ? u : x)) })
  const dupRule = (i: number) => {
    const copy = { ...route.rules[i], id: newId() }
    onChange({ ...route, rules: [...route.rules.slice(0, i + 1), copy, ...route.rules.slice(i + 1)] })
  }
  // 이 라우트 원클릭 테스트 — 경로 파라미터({id})는 예시값으로 채워 mock 에 실제 요청
  const [test, setTest] = useState<{ status: number; body: string } | string | null>(null)
  const [testing, setTesting] = useState(false)
  const runTest = async () => {
    // 테스트는 저장된 mock 을 호출하므로 미저장 편집을 먼저 반영(아니면 stale 상태 테스트)
    if (!(await ensureSaved())) return
    setTesting(true); setTest(null)
    try {
      const p = route.path.replace(/\{[^}]+\}/g, '1') // {id} → 1
      const hasBody = route.method !== 'GET' && route.method !== 'HEAD'
      const res = await fetch(base + p, { method: route.method, headers: hasBody ? { 'Content-Type': 'application/json' } : undefined, body: hasBody ? '{}' : undefined })
      setTest({ status: res.status, body: (await res.text()).slice(0, 2000) })
    } catch (e) { setTest(e instanceof Error ? e.message : String(e)) }
    finally { setTesting(false) }
  }
  return (
    <div style={{ border: '1px solid var(--fl-border)', borderLeft: `3px solid ${methodColor(route.method)}`, borderRadius: 'var(--fl-radius)', padding: 14, background: 'var(--fl-surface)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...input, minWidth: 90 }} value={route.method} onChange={(e) => onChange({ ...route, method: e.target.value })}>
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={route.path} onChange={(e) => onChange({ ...route, path: e.target.value })} placeholder="/users/{id}" />
        <button style={{ ...miniBtn, color: 'var(--fl-primary)' }} onClick={runTest} disabled={testing} title="이 라우트로 바로 요청을 보내 응답을 봅니다">{testing ? '…' : '▶ 테스트'}</button>
        <button style={miniBtn} onClick={onDup} title="라우트 복제">복제</button>
        <button style={miniBtn} onClick={onUp} title="위로">↑</button>
        <button style={miniBtn} onClick={onDown} title="아래로">↓</button>
        <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onRemove}>삭제</button>
      </div>
      {test != null && (
        <div style={{ marginTop: 8, border: `1px solid ${typeof test === 'string' ? 'var(--fl-fail)' : 'var(--fl-border)'}`, borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }}>
          {typeof test === 'string'
            ? <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--fl-fail)' }}>{test}</div>
            : <><div style={{ padding: '5px 10px', fontSize: 12, fontWeight: 600, background: 'var(--fl-surface-2)', color: test.status < 400 ? 'var(--fl-ok)' : 'var(--fl-fail)' }}>HTTP {test.status}</div>
                <pre style={{ margin: 0, padding: '8px 10px', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 180, overflow: 'auto', color: 'var(--fl-text)' }}>{test.body}</pre></>}
        </div>
      )}
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        {route.rules.map((u, i) => (
          <RuleCard
            key={u.id}
            rule={u}
            index={i}
            total={route.rules.length}
            onChange={(nu) => setRule(i, nu)}
            onDup={() => dupRule(i)}
            onRemove={() => onChange({ ...route, rules: route.rules.filter((_, xi) => xi !== i) })}
          />
        ))}
      </div>
      <button
        style={{ ...miniBtn, marginTop: 10 }}
        onClick={() => onChange({ ...route, rules: [...route.rules, { id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] })}
      >+ 규칙 추가</button>
    </div>
  )
}

function RuleCard({ rule, index, total, onChange, onDup, onRemove }: {
  rule: MockRuleSpec
  index: number
  total: number
  onChange: (u: MockRuleSpec) => void
  onDup: () => void
  onRemove: () => void
}) {
  const [showCb, setShowCb] = useState(!!rule.callback?.url)
  const conds = rule.when ?? []
  const setCond = (i: number, c: MockCond) => onChange({ ...rule, when: conds.map((x, xi) => (xi === i ? c : x)) })
  const cb = rule.callback ?? {}
  const setCb = (patch: Partial<typeof cb>) => onChange({ ...rule, callback: { ...cb, ...patch } })
  return (
    <div style={{ border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)' }}>
          규칙 {index + 1}/{total} {conds.length === 0 && '(조건 없음 = 기본)'}
        </span>
        <span style={{ fontSize: 12, marginLeft: 'auto' }}>status</span>
        <input
          style={{ ...input, width: 72, fontFamily: 'var(--fl-font-mono)' }}
          value={rule.status ?? 200}
          onChange={(e) => onChange({ ...rule, status: Number(e.target.value) || 200 })}
        />
        <select style={{ ...input, minWidth: 100 }} value={rule.contentType ?? 'json'} onChange={(e) => onChange({ ...rule, contentType: e.target.value })}>
          {CONTENT_TYPES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select style={{ ...input, minWidth: 90 }} value={rule.charset ?? 'UTF-8'} onChange={(e) => onChange({ ...rule, charset: e.target.value })}>
          {CHARSETS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <span style={{ fontSize: 12 }}>지연(ms)</span>
        <input
          style={{ ...input, width: 84, fontFamily: 'var(--fl-font-mono)' }}
          value={rule.delayMs ?? 0}
          onChange={(e) => onChange({ ...rule, delayMs: Number(e.target.value) || 0 })}
        />
        <button style={miniBtn} onClick={onDup} title="규칙 복제">복제</button>
        <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={onRemove}>규칙 삭제</button>
      </div>

      {/* 조건 */}
      <div style={{ marginTop: 8 }}>
        {conds.map((c, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <select style={{ ...input, minWidth: 86 }} value={c.source} onChange={(e) => setCond(i, { ...c, source: e.target.value as MockCond['source'] })}>
              {COND_SOURCES.map((s) => <option key={s}>{s}</option>)}
            </select>
            <input style={{ ...input, width: 130, fontFamily: 'var(--fl-font-mono)' }} value={c.key} placeholder="키" onChange={(e) => setCond(i, { ...c, key: e.target.value })} />
            <select style={{ ...input, minWidth: 92 }} value={c.op} onChange={(e) => setCond(i, { ...c, op: e.target.value as MockCond['op'] })}>
              {COND_OPS.map((o) => <option key={o}>{o}</option>)}
            </select>
            {c.op !== 'exists' && (
              <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={c.value ?? ''} placeholder="값" onChange={(e) => setCond(i, { ...c, value: e.target.value })} />
            )}
            <button style={miniBtn} onClick={() => onChange({ ...rule, when: conds.filter((_, xi) => xi !== i) })}>×</button>
          </div>
        ))}
        <button
          style={{ ...miniBtn, marginTop: 6 }}
          onClick={() => onChange({ ...rule, when: [...conds, { source: 'body', key: '', op: 'eq', value: '' }] })}
        >+ 조건 (요청 값으로 분기)</button>
      </div>

      {/* 본문 */}
      <textarea
        style={{ ...input, width: '100%', minHeight: 74, marginTop: 8, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
        value={rule.body ?? ''}
        placeholder={'응답 본문 — 예: {"orderId":"{{body.orderId}}","status":"{{state.status}}"}'}
        onChange={(e) => onChange({ ...rule, body: e.target.value })}
      />

      {/* 상태 설정(setState) — 상태 있는 목: 응답 후 서버 상태 갱신 → 다음 호출 조건(source=state)/템플릿({{state.x}}) */}
      <div style={{ marginTop: 8 }}>
        {(rule.setState ?? []).map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', alignSelf: 'center' }}>state.</span>
            <input style={{ ...input, flex: 1 }} value={s.key} placeholder="키(예: status)" onChange={(e) => onChange({ ...rule, setState: (rule.setState ?? []).map((x, xi) => xi === i ? { ...x, key: e.target.value } : x) })} />
            <input style={{ ...input, flex: 1.4 }} value={s.value} placeholder="값(템플릿, 예: approved)" onChange={(e) => onChange({ ...rule, setState: (rule.setState ?? []).map((x, xi) => xi === i ? { ...x, value: e.target.value } : x) })} />
            <button style={miniBtn} onClick={() => onChange({ ...rule, setState: (rule.setState ?? []).filter((_, xi) => xi !== i) })}>×</button>
          </div>
        ))}
        <button style={miniBtn} onClick={() => onChange({ ...rule, setState: [...(rule.setState ?? []), { key: '', value: '' }] })}>+ 상태 설정 (호출 후 저장 · 다음 호출에 {'{{state.x}}'}로 보임)</button>
      </div>

      {/* 콜백 발사 */}
      <div style={{ marginTop: 8 }}>
        <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showCb}
            onChange={(e) => {
              setShowCb(e.target.checked)
              if (!e.target.checked) onChange({ ...rule, callback: null })
            }}
          />
          응답 후 콜백(웹훅) 발사 — 승인·입금 알림 콜백 패턴
        </label>
        {showCb && (
          <div style={{ display: 'grid', gap: 6, marginTop: 6, paddingLeft: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, flexShrink: 0 }}>지연(ms)</span>
              <input style={{ ...input, width: 90, fontFamily: 'var(--fl-font-mono)' }} value={cb.afterMs ?? 500} onChange={(e) => setCb({ afterMs: Number(e.target.value) || 0 })} />
              <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={cb.url ?? ''} placeholder="URL 템플릿 — 예: {{body.notiUrl}}" onChange={(e) => setCb({ url: e.target.value })} />
              <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={cb.retryUntilOk ?? true} onChange={(e) => setCb({ retryUntilOk: e.target.checked })} />
                OK 재시도
              </label>
            </div>
            <textarea
              style={{ ...input, width: '100%', minHeight: 46, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
              value={cb.body ?? ''}
              placeholder="콜백 본문(urlencoded) — 예: resultCode=0000&orderId={{body.orderId}}"
              onChange={(e) => setCb({ body: e.target.value })}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- TCP mock (고정길이 전문) ----------

function TcpEditor({ tcp, onChange }: { tcp: MockTcpSpec | null; onChange: (t: MockTcpSpec | null) => void }) {
  const on = !!tcp
  const t = tcp ?? {}
  const set = (patch: Partial<MockTcpSpec>) => onChange({ ...t, ...patch })
  const rules = t.rules ?? []
  const setRule = (i: number, patch: Partial<MockTcpRuleSpec>) =>
    set({ rules: rules.map((r, ri) => (ri === i ? { ...r, ...patch } : r)) })
  return (
    <section style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={h2}>TCP 전문 mock</h2>
        <label style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => onChange(e.target.checked
              ? { enabled: true, port: t.port ?? 9091, charset: t.charset ?? 'EUC-KR', prefixLength: t.prefixLength ?? 4, prefixIncludesSelf: t.prefixIncludesSelf ?? false, rules: rules.length ? rules : [{ id: newId(), contains: '', response: '00{{req:4:12}}' }] }
              : null)}
          />
          사용 — 저장하면 지정 포트에 TCP 리스너가 열립니다
        </label>
      </div>
      <p style={hint}>
        고정길이 전문(길이 프리픽스) 대상 시스템을 흉내냅니다 — 워크플로의 <b>TCP 전문</b> 노드가 여기로 붙습니다.
        응답 템플릿: <code style={code}>{'{{req}}'}</code> 요청 전문 전체 · <code style={code}>{'{{req:오프셋:길이}}'}</code> 요청 바이트 슬라이스.
      </p>
      {on && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12 }}>포트</span>
            <input style={{ ...input, width: 90, fontFamily: 'var(--fl-font-mono)' }} value={t.port ?? 9091} onChange={(e) => set({ port: Number(e.target.value) || 0 })} />
            <span style={{ fontSize: 12 }}>인코딩</span>
            <select style={{ ...input, minWidth: 96 }} value={t.charset ?? 'EUC-KR'} onChange={(e) => set({ charset: e.target.value })}>
              {['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII'].map((c) => <option key={c}>{c}</option>)}
            </select>
            <span style={{ fontSize: 12 }}>길이 프리픽스</span>
            <input style={{ ...input, width: 60, fontFamily: 'var(--fl-font-mono)' }} value={t.prefixLength ?? 4} onChange={(e) => set({ prefixLength: Number(e.target.value) || 0 })} />
            <label style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={!!t.prefixIncludesSelf} onChange={(e) => set({ prefixIncludesSelf: e.target.checked })} />
              프리픽스 포함 길이
            </label>
            <span style={{ ...code, marginLeft: 'auto' }}>{`${window.location.hostname || 'localhost'}:${t.port ?? 9091}`}</span>
          </div>
          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            {rules.map((r, i) => (
              <div key={r.id} style={{ border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 10 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', flexShrink: 0 }}>규칙 {i + 1}</span>
                  <span style={{ fontSize: 12, flexShrink: 0 }}>요청에 포함:</span>
                  <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={r.contains ?? ''} placeholder="비우면 항상 매칭(기본 규칙) — 예: BAL1" onChange={(e) => setRule(i, { contains: e.target.value })} />
                  <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => set({ rules: rules.filter((_, ri) => ri !== i) })}>×</button>
                </div>
                <textarea
                  style={{ ...input, width: '100%', minHeight: 46, marginTop: 6, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
                  value={r.response ?? ''}
                  placeholder={'응답 전문 — 예: 00{{req:4:12}}홍길동    '}
                  onChange={(e) => setRule(i, { response: e.target.value })}
                />
              </div>
            ))}
            <button style={{ ...miniBtn, justifySelf: 'start' }} onClick={() => set({ rules: [...rules, { id: newId(), contains: '', response: '' }] })}>+ TCP 규칙</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------- 보내보기 ----------

function TestPanel({ base, ensureSaved }: { base: string; ensureSaved: () => Promise<boolean> }) {
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/')
  const [body, setBody] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!(await ensureSaved())) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(base + path, {
        method,
        headers: method === 'GET' || method === 'HEAD' ? undefined : { 'Content-Type': body.trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded' },
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      })
      const text = await res.text()
      setResult(`HTTP ${res.status} · ${res.headers.get('content-type') ?? ''}\n\n${text.slice(0, 4000)}`)
    } catch (e) {
      setResult(`요청 실패: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={panel}>
      <h2 style={h2}>보내보기</h2>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
        <select style={{ ...input, minWidth: 90 }} value={method} onChange={(e) => setMethod(e.target.value)}>
          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
        </select>
        <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/hello?name=kim" />
        <button style={primaryBtn} disabled={busy} onClick={() => { void send() }}>전송</button>
      </div>
      {method !== 'GET' && (
        <textarea
          style={{ ...input, width: '100%', minHeight: 56, marginTop: 8, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='요청 본문 — {"otp":"111111"} 또는 a=1&b=2'
        />
      )}
      {result && (
        <pre style={{ marginTop: 10, padding: 12, background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius-sm)', fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 260, overflow: 'auto' }}>{result}</pre>
      )}
    </section>
  )
}

// ---------- 스타일 ----------

const panel: CSSProperties = {
  marginTop: 22,
  padding: 18,
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius)',
  background: 'var(--fl-surface)',
}

const h2: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }

const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }

const code: CSSProperties = {
  fontFamily: 'var(--fl-font-mono)',
  fontSize: 11,
  background: 'var(--fl-surface-2)',
  padding: '1px 5px',
  borderRadius: 4,
}

const input: CSSProperties = {
  padding: '7px 10px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontSize: 13,
}

const primaryBtn: CSSProperties = {
  padding: '8px 18px',
  border: 'none',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-primary)',
  color: '#fff',
  fontWeight: 700,
  fontSize: 13.5,
  cursor: 'pointer',
}

const miniBtn: CSSProperties = {
  padding: '5px 10px',
  border: '1px solid var(--fl-border)',
  borderRadius: 'var(--fl-radius-sm)',
  background: 'var(--fl-surface)',
  color: 'var(--fl-text)',
  fontSize: 12,
  cursor: 'pointer',
}

const badge: CSSProperties = {
  padding: '3px 9px',
  borderRadius: 'var(--fl-radius-pill)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 700,
}
