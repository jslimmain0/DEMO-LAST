import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { HttpMethod, MockRequestLog, MockRouteSpec, MockServerSpec } from '../api/types'
import { adminApi, mockBaseUrl, mocksApi, secretsApi, workspacesApi } from '../api/client'
import type { SecretView } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { MockAssistantPanel } from '../components/MockAssistantPanel'
import { MockCodecEditor } from '../components/MockCodecEditor'
import { RoutesEditor } from '../components/MockRouteEditor'
import { bodyKeys, findRouteIndex, interestingHeaders, mergeExpect } from '../lib/mockRequestLog'
import { MockTcpEditor } from '../components/MockTcpEditor'
import { MockExportDialog, MockReplaceSpecDialog } from '../components/MockTransferDialog'
import { AssistantLoginGate } from '../components/AssistantLoginGate'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { useReadableInk } from '../lib/contrast'
import { mockSources } from '../lib/mockSources'
import { newId } from '../lib/ids'


/** Mock 서버 편집기 — 경로별 라우트/규칙(응답 템플릿·조건·콜백)을 정의하고 바로 보내본다. */
export function MockServerEditor() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const { canEdit: canEditGlobal } = usePermissions()
  const { me, isGuest } = useAuth()
  const aiMe = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000 })
  const aiPending = aiMe.data?.myStatus === 'PENDING' // 승인 대기 — AI 게이트
  const badgeInk = useReadableInk('var(--fl-cat-generic)')
  const detail = useQuery({ queryKey: ['mock-server', id], queryFn: () => mocksApi.get(id), enabled: !!id })
  // 워크스페이스 롤 합성 — 팀 mock 의 VIEWER 는 편집 UI 도 읽기전용(백엔드 403 선반영)
  const wss = useQuery({ queryKey: ['workspaces'], queryFn: workspacesApi.list })
  const wsRole = detail.data?.workspaceId
    ? (wss.data?.find((w) => w.id === detail.data!.workspaceId)?.myRole ?? 'VIEWER')
    : 'EDITOR'
  const canEdit = canEditGlobal && wsRole !== 'VIEWER'

  const [spec, setSpec] = useState<MockServerSpec>({ routes: [] })
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [transfer, setTransfer] = useState<'export' | 'import' | null>(null) // 텍스트 복붙 내보내기/가져오기(덮어쓰기)
  // 시크릿 볼트 — {{ 이름@secret }} 피커 소스 + 시크릿 환경(스코프) 셀렉트 옵션. 게스트(403)면 빈 목록.
  const secretsQ = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list, retry: false })
  const secrets: SecretView[] = secretsQ.data ?? []
  const secretEnvs = [...new Set(secrets.map((x) => x.environment).filter((x): x is string => !!x))].sort()

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
              <span style={{ ...badge, background: 'var(--fl-cat-generic)', color: badgeInk }}>{d.kind === 'CUSTOM' ? 'Mock' : `${d.kind} Mock`}</span>
              <button
                style={{ ...miniBtn, color: d.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', opacity: canEdit ? 1 : 0.5 }}
                disabled={!canEdit}
                title={canEdit ? undefined : 'viewer 역할은 변경할 수 없습니다'}
                onClick={() => toggle.mutate()}
              >
                {d.enabled ? '● 서빙 중' : '○ 꺼짐'}
              </button>
              <button style={{ ...miniBtn, marginLeft: 'auto' }} title="이 Mock 을 JSON 텍스트로 복사/다운로드(다른 워크스페이스·서버에 붙여넣기)" onClick={() => setTransfer('export')}>⬆ 내보내기</button>
              {canEdit && <button style={miniBtn} title="내보내기 JSON 을 붙여넣어 이 Mock 의 정의를 교체" onClick={() => setTransfer('import')}>⬇ 가져오기</button>}
              {canEdit && (
                <button style={{ ...miniBtn, border: '1px solid var(--fl-primary)', color: 'var(--fl-primary)' }} title="AI 로 mock 만들기/고치기" onClick={() => setAiOpen((v) => !v)}>
                  ✨ AI
                </button>
              )}
              <button style={{ ...primaryBtn, marginLeft: 8, opacity: dirty && canEdit ? 1 : 0.55 }} disabled={!dirty || save.isPending || !canEdit} title={canEdit ? undefined : 'viewer 역할은 저장할 수 없습니다'} onClick={() => save.mutate()}>
                저장
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)', flexShrink: 0 }}>base URL:</span>
              <input readOnly value={base} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} />
              <button style={miniBtn} onClick={() => { void navigator.clipboard?.writeText(base).catch(() => {}) }}>⧉ 복사</button>
            </div>
            {note && <p style={{ fontSize: 12.5, marginTop: 8, color: note.startsWith('저장됨') ? 'var(--fl-ok)' : 'var(--fl-fail)' }}>{note}</p>}

            {/* 시크릿 스코프 — 이 Mock 이 {{ 이름@secret }} 를 풀 때 공통 + 어느 환경의 시크릿을 볼지(서빙은 서버에서 도니 Mock 별 설정) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>🔑 시크릿 환경:</span>
              <select style={{ ...input, minWidth: 140 }} value={spec.environment ?? ''} disabled={!canEdit} onChange={(e) => mutate((s) => ({ ...s, environment: e.target.value || null }))} title="{{ 이름@secret }} 해석 스코프 — 공통 시크릿(+Vault)에 이 환경의 시크릿을 덮어씀">
                <option value="">공통만</option>
                {secretEnvs.map((e) => <option key={e} value={e}>{e}</option>)}
                {spec.environment && !secretEnvs.includes(spec.environment) && <option value={spec.environment}>{spec.environment}</option>}
              </select>
              <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>
                {secrets.length ? `적용 가능한 시크릿 ${secrets.filter((x) => !x.environment || x.environment === (spec.environment ?? null)).length}개 — 값 칸에서 { } 로 삽입` : '시크릿 없음(도구 → 시크릿 볼트에서 추가) — 응답 본문·헤더·코덱 키에 {{ 이름@secret }} 로 씁니다'}
              </span>
            </div>

            {/* 유형별 편집 UI — HTTP=라우트, TCP=전문, CUSTOM(레거시)=둘 다 */}
            {d.kind !== 'TCP' && (
              <RoutesEditor
                base={base}
                ensureSaved={ensureSaved}
                mockId={id}
                spec={spec}
                secrets={secrets}
                routes={spec.routes ?? []}
                readOnly={!canEdit}
                onChange={(routes) => mutate((s) => ({ ...s, routes }))}
                extraHeader={canEdit ? <OpenApiImportButton onRoutes={(generated) => mutate((s) => ({ ...s, routes: [...(s.routes ?? []), ...generated] }))} /> : null}
              />
            )}

            {d.kind !== 'HTTP' && (
              <MockTcpEditor
                tcp={spec.tcp ?? null}
                readOnly={!canEdit}
                codec={spec.codec}
                environment={spec.environment}
                sources={mockSources({ spec, secrets, environment: spec.environment, tcp: true })}
                onChange={(tcp) => mutate((s) => ({ ...s, tcp }))}
              />
            )}

            {/* 전문 코덱 — 요청 전/응답 후 변환 플러그인(워크플로 TRANSFORM 과 동일 플러그인) */}
            <section style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h2 style={h2}>전문 코덱 <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>(플러그인 — 요청 전 · 응답 후)</span></h2>
                {spec.codec && <span style={{ ...badge, background: 'var(--fl-primary)' }}>사용 중</span>}
              </div>
              <p style={hint}>
                요청 전문이 <b>매칭·템플릿에 들어가기 전</b>에 풀고(예: Base64 디코딩·복호화), 응답 전문을 <b>다 만든 뒤 나가기 전</b>에 감쌉니다(예: 인코딩·서명).
                변환 플러그인(내장 + 업로드 JAR)을 그대로 씁니다 — 단계는 위에서부터 순서대로 체인. {d.kind !== 'HTTP' && 'TCP 전문도 같은 코덱을 거칩니다. '}
                라우트별로 다른 코덱이 필요하면 라우트 카드의 [이 라우트만 코덱]을 쓰세요. 코덱 실패는 500(HTTP)/연결 종료(TCP)로 명확히 실패합니다.
              </p>
              <div style={{ marginTop: 10 }}>
                <MockCodecEditor codec={spec.codec} readOnly={!canEdit} kind={d.kind === 'TCP' ? 'tcp' : 'http'} mockId={id} environment={spec.environment}
                  sources={mockSources({ spec, secrets, environment: spec.environment, tcp: d.kind === 'TCP' })}
                  fieldHints={d.kind === 'TCP'
                    ? { request: (spec.tcp?.requestFields ?? []).map((f) => f.name ?? '').filter(Boolean), response: [...new Set((spec.tcp?.rules ?? []).flatMap((r) => (r.responseFields ?? []).map((f) => f.name ?? '')).filter(Boolean))] }
                    : { request: [...new Set((spec.routes ?? []).flatMap((r) => (r.expect?.body ?? []).map((f) => f.key)).filter(Boolean))], response: [] }}
                  onChange={(codec) => mutate((s) => ({ ...s, codec }))} />
              </div>
            </section>

            {d.kind !== 'TCP' && <TestPanel base={base} ensureSaved={ensureSaved} />}

            <RuntimePanel id={id} canEdit={canEdit} base={base} spec={spec} onSpec={(fn) => mutate(fn)} />

            {transfer === 'export' && <MockExportDialog mock={d} spec={spec} onClose={() => setTransfer(null)} />}
            {transfer === 'import' && (
              <MockReplaceSpecDialog
                onClose={() => setTransfer(null)}
                onReplace={(newSpec, warnings) => {
                  mutate(() => newSpec)
                  toast(`정의를 교체했습니다 — 저장하면 반영됩니다.${warnings.length ? ' ' + warnings.join(' ') : ''}`, warnings.length ? 'info' : 'ok')
                }}
              />
            )}

            {aiOpen && (isGuest || aiPending
              ? <AssistantLoginGate reason={isGuest ? 'guest' : 'pending'} variant="overlay" onClose={() => setAiOpen(false)} />
              : <MockAssistantPanel
                  spec={spec}
                  mockId={id}
                  onApply={(newSpec) => mutate(() => newSpec)}
                  onClose={() => setAiOpen(false)}
                />)}
          </>
        )}
      </div>
    </AppShellTier1>
  )
}

// ---------- 요청 기록 + 상태(상태 있는 목 디버깅) ----------
function RuntimePanel({ id, canEdit, base, spec, onSpec }: { id: string; canEdit: boolean; base: string; spec: MockServerSpec; onSpec: (fn: (s: MockServerSpec) => MockServerSpec) => void }) {
  const qc = useQueryClient()
  const routes = spec.routes ?? []
  // 실제 온 요청 → 예상 요청 필드(피커 소스·조건 키 후보)로. 매칭 라우트가 없으면 규칙 초안으로 안내.
  const expectFrom = (r: MockRequestLog) => {
    const idx = findRouteIndex(routes, r.method, r.path)
    if (idx < 0) { toast('이 요청에 맞는 라우트가 없습니다 — [규칙 초안]으로 라우트부터 만드세요.', 'error'); return }
    const add = { body: bodyKeys(r.decodedBody ?? r.bodyText), query: r.query, header: interestingHeaders(r.headers) }
    onSpec((s) => ({ ...s, routes: (s.routes ?? []).map((x, i) => (i === idx ? { ...x, expect: mergeExpect(x.expect, add) } : x)) }))
    const n = Object.keys(add.body).length + Object.keys(add.query).length + Object.keys(add.header).length
    toast(`라우트 ${routes[idx].method} ${routes[idx].path} 의 예상 요청에 ${n}개 필드를 반영했습니다.`, 'ok')
  }
  // 기록된 요청으로 규칙 초안 — 라우트 없으면 생성, 있으면 "요청 값 eq 조건" 규칙을 위에 추가
  const draftRule = (r: MockRequestLog) => {
    const idx = findRouteIndex(routes, r.method, r.path)
    const body = bodyKeys(r.decodedBody ?? r.bodyText)
    const add = { body, query: r.query, header: interestingHeaders(r.headers) }
    const conds = [...Object.entries(body).slice(0, 3).map(([k, v]) => ({ source: 'body' as const, key: k, op: 'eq' as const, value: v })),
      ...Object.entries(r.query).slice(0, 2).map(([k, v]) => ({ source: 'query' as const, key: k, op: 'eq' as const, value: v }))]
    if (idx < 0) {
      const route: MockRouteSpec = { id: newId(), method: r.method, path: r.path, expect: mergeExpect(null, add), rules: [{ id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] }
      onSpec((s) => ({ ...s, routes: [...(s.routes ?? []), route] }))
      toast(`라우트 ${r.method} ${r.path} 를 만들었습니다(기본 규칙 + 예상 요청). 저장하면 반영됩니다.`, 'ok')
      return
    }
    onSpec((s) => ({ ...s, routes: (s.routes ?? []).map((x, i) => (i === idx ? { ...x, expect: mergeExpect(x.expect, add), rules: [{ id: newId(), when: conds, status: 200, contentType: 'json', body: '{"ok":true}' }, ...x.rules] } : x)) }))
    toast(`라우트 ${routes[idx].method} ${routes[idx].path} 위에 조건 ${conds.length}개짜리 규칙 초안을 추가했습니다.`, 'ok')
  }
  // 기록된 요청 재전송(코덱/규칙 수정 후 같은 요청으로 다시 확인)
  const replay = async (r: MockRequestLog) => {
    const qs = Object.entries(r.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    const hasBody = r.method !== 'GET' && r.method !== 'HEAD'
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.headers)) if (k === 'content-type' || !['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) headers[k] = v
    try {
      const res = await fetch(base + r.path + (qs ? `?${qs}` : ''), { method: r.method, headers, body: hasBody ? r.bodyText : undefined })
      toast(`재전송 → HTTP ${res.status}`, res.ok ? 'ok' : 'error')
      qc.invalidateQueries({ queryKey: ['mock-requests', id] })
    } catch (e) { toast(`재전송 실패: ${(e as Error).message}`, 'error') }
  }
  const [open, setOpen] = useState(false)
  const reqs = useQuery({ queryKey: ['mock-requests', id], queryFn: () => mocksApi.requests(id), enabled: open, refetchInterval: open ? 3000 : false })
  const st = useQuery({ queryKey: ['mock-state', id], queryFn: () => mocksApi.state(id), enabled: open, refetchInterval: open ? 3000 : false })
  const reset = useMutation({ mutationFn: () => mocksApi.reset(id), onSuccess: () => { toast('상태·기록을 초기화했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['mock-requests', id] }); qc.invalidateQueries({ queryKey: ['mock-state', id] }) } })
  const clear = useMutation({ mutationFn: () => mocksApi.clearRequests(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['mock-requests', id] }) })
  const [openReq, setOpenReq] = useState<number | null>(null)
  const stateKeys = Object.keys(st.data?.state ?? {})

  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button style={{ ...miniBtn, fontWeight: 700 }} onClick={() => setOpen((v) => !v)}>{open ? '▾' : '▸'} 요청 기록 · 상태</button>
        {open && <>
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>mock 에 온 실제 요청과 상태 있는 목의 현재 상태(3초 갱신)</span>
          {canEdit && <button style={{ ...miniBtn, marginLeft: 'auto', color: 'var(--fl-fail)' }} onClick={() => reset.mutate()} title="state·seq·hits·요청기록 전부 초기화">↺ 상태 초기화</button>}
        </>}
      </div>
      {open && (
        <div style={{ marginTop: 10, display: 'grid', gap: 14 }}>
          {/* 현재 상태 */}
          <div style={{ border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 12, background: 'var(--fl-surface-2)' }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)', marginBottom: 6 }}>현재 상태 · seq {st.data?.seq ?? '—'} · 요청 {st.data?.requestCount ?? 0}건</div>
            {stateKeys.length === 0 ? <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>상태 없음(setState 규칙 실행 전).</span>
              : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{stateKeys.map((k) => (
                  <code key={k} style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 6, padding: '2px 7px' }}>{k} = {st.data!.state[k]}</code>
                ))}</div>}
          </div>
          {/* 요청 기록 */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--fl-text-muted)' }}>요청 기록 (최신 {reqs.data?.length ?? 0})</span>
              {(reqs.data?.length ?? 0) > 0 && canEdit && <button style={miniBtn} onClick={() => clear.mutate()}>기록 비우기</button>}
            </div>
            {(reqs.data?.length ?? 0) === 0 ? <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>아직 요청이 없습니다. mock URL 을 호출하면 여기에 기록됩니다.</span>
              : <div style={{ display: 'grid', gap: 4 }}>{reqs.data!.map((r, i) => (
                  <div key={i} style={{ border: '1px solid var(--fl-border)', borderRadius: 6, overflow: 'hidden' }}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--fl-text)' }} onClick={() => setOpenReq(openReq === i ? null : i)}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: METHOD_COLOR[r.method as HttpMethod] ?? 'var(--fl-text-muted)', minWidth: 44 }}>{r.method}</span>
                      <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.path}</code>
                      <span style={{ fontSize: 11, color: r.status >= 400 ? 'var(--fl-fail)' : 'var(--fl-ok)', fontFamily: 'var(--fl-font-mono)' }}>{r.status}</span>
                      {r.matchedRuleId == null && <span style={{ fontSize: 10, color: 'var(--fl-fail)' }}>무매칭</span>}
                    </button>
                    {openReq === i && (
                      <div style={{ padding: '0 10px 10px', display: 'grid', gap: 6 }}>
                        {Object.keys(r.query).length > 0 && <pre style={reqPre}>query: {JSON.stringify(r.query)}</pre>}
                        {r.bodyText && <pre style={reqPre}>body: {r.bodyText}</pre>}
                        {r.decodedBody != null && <pre style={{ ...reqPre, borderLeft: '3px solid var(--fl-primary)' }}>코덱 적용 후: {r.decodedBody}</pre>}
                        <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{r.matchedRuleId ? `규칙 ${r.matchedRuleId}` : '매칭 규칙 없음(404)'}{r.callbackFired ? ' · 콜백 발사' : ''}{r.delayMs ? ` · 지연 ${r.delayMs}ms` : ''}</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {canEdit && <button style={miniBtn} onClick={() => expectFrom(r)} title="이 요청의 본문/쿼리/헤더 키를 라우트의 예상 요청 필드로(피커·조건 후보)">예상 필드로</button>}
                          {canEdit && <button style={miniBtn} onClick={() => draftRule(r)} title="이 요청에 맞는 라우트/규칙 초안 만들기(요청 값 eq 조건)">규칙 초안</button>}
                          <button style={miniBtn} onClick={() => { void replay(r) }} title="같은 요청을 다시 보냅니다(코덱/규칙 수정 후 확인)">재전송</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}</div>}
          </div>
        </div>
      )}
    </section>
  )
}

const reqPre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface-2)', borderRadius: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto' }

// ---------- OpenAPI 가져오기(라우트 자동 생성) ----------

function OpenApiImportButton({ onRoutes }: { onRoutes: (r: MockRouteSpec[]) => void }) {
  const [openApi, setOpenApi] = useState<string | null>(null)
  return (
    <>
      <button style={miniBtn} onClick={() => setOpenApi(openApi === null ? '' : null)} title="OpenAPI/Swagger 문서를 붙여넣어 라우트 자동 생성">OpenAPI 가져오기</button>
      {openApi !== null && (
        <div style={{ flexBasis: '100%', margin: '8px 0' }}>
          <textarea autoFocus value={openApi} onChange={(e) => setOpenApi(e.target.value)} placeholder="OpenAPI 3 / Swagger 2 JSON 을 붙여넣으세요…"
            style={{ ...input, width: '100%', minHeight: 90, fontFamily: 'var(--fl-font-mono)', fontSize: 12, boxSizing: 'border-box' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button style={{ ...miniBtn, color: 'var(--fl-primary)' }} onClick={() => {
              const generated = openApiToMockRoutes(openApi)
              if (!generated.length) { toast('라우트를 추출하지 못했습니다 — 유효한 OpenAPI/Swagger JSON 인지 확인하세요.', 'error'); return }
              onRoutes(generated)
              setOpenApi(null)
              toast(`라우트 ${generated.length}개를 생성했습니다.`, 'ok')
            }}>가져오기</button>
            <button style={miniBtn} onClick={() => setOpenApi(null)}>취소</button>
          </div>
        </div>
      )}
    </>
  )
}

// ---------- 커스텀 라우트 편집(OpenAPI 변환) ----------

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
        <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/hello?name=kim"
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); void send() } }} />
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
