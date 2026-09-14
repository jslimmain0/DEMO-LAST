import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { HttpMethod, MockRequestLog, MockRouteSpec, MockServerSpec, MockTcpRuleSpec, MockTcpSpec } from '../api/types'
import { adminApi, flowsApi, mockBaseUrl, mocksApi, secretsApi, workspacesApi } from '../api/client'
import type { SecretView } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { useAuth, usePermissions } from '../auth/AuthContext'
import { makeNode } from '../canvas/nodeFactory'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { AssistantLoginGate } from '../components/AssistantLoginGate'
import { MockAssistantPanel } from '../components/MockAssistantPanel'
import { MockCodecEditor } from '../components/MockCodecEditor'
import { RouteCard } from '../components/MockRouteEditor'
import { TcpConnectionPanel, TcpLayoutPanel, TcpPreviewPanel, TcpRuleDetail, tcpRuleSummary } from '../components/MockTcpEditor'
import { MockExportDialog, MockReplaceSpecDialog } from '../components/MockTransferDialog'
import { MockVersionHistoryDialog } from '../components/MockVersionHistoryDialog'
import { Modal } from '../components/Modal'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { useReadableInk } from '../lib/contrast'
import { newId } from '../lib/ids'
import { stepCount } from '../lib/mockCodecOps'
import { openApiToMockRoutes } from '../lib/mockOpenApi'
import { bodyKeys, findRouteIndex, interestingHeaders, mergeExpect } from '../lib/mockRequestLog'
import { mockSources } from '../lib/mockSources'
import { mockTcpToNode } from '../lib/tcpMirror'
import { relTime } from '../lib/format'

const methodColor = (m: string): string => METHOD_COLOR[m as HttpMethod] ?? 'var(--fl-cat-generic)'
const EMPTY_TCP: MockTcpSpec = { enabled: true, port: 9091, charset: 'EUC-KR', prefixLength: 4, prefixIncludesSelf: false, requestFields: [], rules: [] }

/** 좌측 탐색 선택 — HTTP: 라우트 = 노드 / TCP: 규칙 = 노드. 우측 상세 = 속성 패널 은유. */
type NavSel =
  | { kind: 'route'; id: string }   // HTTP 라우트
  | { kind: 'conn' }                // TCP 연결(포트·인코딩·프리픽스)
  | { kind: 'layout' }              // TCP 요청 레이아웃
  | { kind: 'rule'; id: string }    // TCP 규칙
  | { kind: 'codec' } | { kind: 'settings' } | { kind: 'overview' }

/**
 * Mock 편집기 — **HTTP 는 HTTP 만, TCP 는 TCP 만**(섞이지 않음). 좌 목록 | 우 상세 | 하단 트래픽 패널.
 * - HTTP: 좌 라우트 목록(메서드·경로·히트) · 본문·헤더 코덱 · 설정 · 개요. 우 = 라우트 상세(예상 요청·규칙·필드 ◈ 코덱).
 * - TCP: 좌 연결 · 요청 레이아웃 · 규칙 목록(조건 요약·히트) · 전문 코덱 · 설정. 우 = 규칙 상세(조건·응답 필드·◈ 코덱). 미리보기는 트래픽 패널 탭.
 * - CUSTOM(레거시, HTTP+TCP 혼합): HTTP 편집기로 열리고 상단 안내 + [TCP Mock 으로 분리].
 * 헤더: 이름 인라인·미저장 표시·자동 저장·Ctrl+S·🕘 버전·⋯ 도구·✨ AI.
 */
export function MockServerEditor() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { canEdit: canEditGlobal } = usePermissions()
  const { me, isGuest } = useAuth()
  const aiMe = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000 })
  const aiPending = aiMe.data?.myStatus === 'PENDING'
  const badgeInk = useReadableInk('var(--fl-cat-generic)')
  const detail = useQuery({ queryKey: ['mock-server', id], queryFn: () => mocksApi.get(id), enabled: !!id })
  const wss = useQuery({ queryKey: ['workspaces'], queryFn: workspacesApi.list })
  const wsRole = detail.data?.workspaceId ? (wss.data?.find((w) => w.id === detail.data!.workspaceId)?.myRole ?? 'VIEWER') : 'EDITOR'
  const canEdit = canEditGlobal && wsRole !== 'VIEWER'

  const [spec, setSpec] = useState<MockServerSpec>({ routes: [] })
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [transfer, setTransfer] = useState<'export' | 'import' | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [jsonOpen, setJsonOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [autosave, setAutosave] = useState(() => { try { return localStorage.getItem('fl:mock:autosave') === '1' } catch { return false } })
  const [nav, setNav] = useState<NavSel>({ kind: 'overview' })
  const [navQ, setNavQ] = useState('')
  const [trafficOpen, setTrafficOpen] = useState(() => { try { return localStorage.getItem('fl:mock:traffic') !== '0' } catch { return true } })
  const [trafficTab, setTrafficTab] = useState<'log' | 'send' | 'preview'>('log')
  const [previewSample, setPreviewSample] = useState('')
  const secretsQ = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list, retry: false })
  const secrets: SecretView[] = secretsQ.data ?? []
  const secretEnvs = [...new Set(secrets.map((x) => x.environment).filter((x): x is string => !!x))].sort()

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['mock-server', id] })
    void qc.invalidateQueries({ queryKey: ['mock-servers'] })
    void qc.invalidateQueries({ queryKey: ['mock-versions', id] })
  }, [qc, id])

  // 서버 정의 로드 → 로컬 편집 상태. 첫 로드 시 첫 라우트/규칙(있으면) 선택.
  const loadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!detail.data) return
    // 저장 직후 재조회는 대개 내용이 같다 — 같으면 참조를 유지해 편집 중인 텍스트 버퍼([필드|텍스트])가 재생성되지 않게 한다.
    const loaded = detail.data.spec ?? { routes: [] }
    setSpec((cur) => (JSON.stringify(cur) === JSON.stringify(loaded) ? cur : loaded))
    setName(detail.data.name)
    setDirty(false)
    if (loadedRef.current !== detail.data.id) {
      loadedRef.current = detail.data.id
      if (detail.data.kind === 'TCP') {
        const firstRule = detail.data.spec?.tcp?.rules?.[0]
        setNav(firstRule ? { kind: 'rule', id: firstRule.id } : { kind: 'conn' })
      } else {
        const first = detail.data.spec?.routes?.[0]
        setNav(first ? { kind: 'route', id: first.id } : { kind: 'overview' })
      }
    }
  }, [detail.data])

  const save = useMutation({
    mutationFn: async () => {
      if (name.trim() && name.trim() !== detail.data?.name) await mocksApi.update(id, { name: name.trim() })
      return mocksApi.updateSpec(id, spec)
    },
    onSuccess: () => { setDirty(false); setNote('저장됨 — 즉시 서빙에 반영됩니다.'); invalidate() },
    onError: (e) => setNote(apiErrorMessage(e, '저장에 실패했습니다')),
  })
  const toggle = useMutation({ mutationFn: () => mocksApi.update(id, { enabled: !detail.data?.enabled }), onSuccess: invalidate })
  const reset = useMutation({ mutationFn: () => mocksApi.reset(id), onSuccess: () => { toast('상태·요청 기록을 초기화했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['mock-requests', id] }); qc.invalidateQueries({ queryKey: ['mock-state', id] }) } })
  const duplicate = useMutation({
    mutationFn: async () => {
      const d = detail.data!
      let candidate = `${d.slug}-2`
      for (let n = 2; n < 30; n++) { candidate = `${d.slug.slice(0, 40 - String(n).length - 1)}-${n}`; if ((await mocksApi.slugCheck(candidate)).available) break }
      const created = await mocksApi.create({ name: `${d.name} (복제)`, slug: candidate, type: d.kind === 'TCP' ? 'TCP' : 'HTTP', workspaceId: d.workspaceId ?? null })
      const s = spec.tcp ? { ...spec, tcp: { ...spec.tcp, enabled: false } } : spec // TCP 포트 충돌 방지 — 리스너 꺼서 복제(연결 화면에서 포트 바꾸고 켬)
      await mocksApi.updateSpec(created.id, s, { note: `${d.slug} 복제` })
      return created
    },
    onSuccess: (c) => { toast(`'${c.name}' 으로 복제했습니다.`, 'ok'); qc.invalidateQueries({ queryKey: ['mock-servers'] }); navigate(`/mocks/${c.id}`) },
    onError: (e) => toast(apiErrorMessage(e, '복제 실패'), 'error'),
  })
  // 레거시(CUSTOM: HTTP+TCP 혼합) → TCP 부분을 새 TCP Mock 으로 분리하고 이 Mock 은 HTTP 만 남긴다
  const splitTcp = useMutation({
    mutationFn: async () => {
      const d = detail.data!
      let candidate = `${d.slug.slice(0, 36)}-tcp`
      for (let n = 1; n < 30; n++) { candidate = n === 1 ? `${d.slug.slice(0, 36)}-tcp` : `${d.slug.slice(0, 40 - String(n).length - 5)}-tcp-${n}`; if ((await mocksApi.slugCheck(candidate)).available) break }
      const created = await mocksApi.create({ name: `${d.name} (TCP)`, slug: candidate, type: 'TCP', workspaceId: d.workspaceId ?? null })
      // 원본 리스너를 먼저 닫아야(tcp 제거 저장) 같은 포트로 새 Mock 이 열린다
      const httpOnly: MockServerSpec = { ...spec, tcp: null }
      await mocksApi.updateSpec(id, httpOnly, { note: 'TCP 분리 — HTTP 만 남김' })
      await mocksApi.updateSpec(created.id, { tcp: { ...(spec.tcp ?? EMPTY_TCP), enabled: true }, codec: spec.codec ?? null, environment: spec.environment ?? null }, { note: `${d.slug} 에서 TCP 분리` })
      return created
    },
    onSuccess: (c) => { toast(`TCP 부분을 '${c.name}' 으로 분리했습니다. 이 Mock 은 HTTP 만 남았습니다.`, 'ok'); setDirty(false); invalidate(); navigate(`/mocks/${c.id}`) },
    onError: (e) => toast(apiErrorMessage(e, 'TCP 분리 실패'), 'error'),
  })

  const mutate = useCallback((fn: (s: MockServerSpec) => MockServerSpec) => { setSpec((s) => fn(s)); setDirty(true); setNote(null) }, [])
  const d = detail.data
  const base = d ? mockBaseUrl(d.slug, me?.tenant) : ''
  const kind = d?.kind ?? 'HTTP'
  const isTcp = kind === 'TCP'
  const isHttp = !isTcp
  const legacyMixed = !isTcp && !!spec.tcp // HTTP(또는 레거시 CUSTOM) Mock 에 TCP 섹션이 섞여 있음 — 분리 안내
  const routes = useMemo(() => spec.routes ?? [], [spec.routes])
  const tcp = useMemo(() => spec.tcp ?? EMPTY_TCP, [spec.tcp])
  const tcpRules = useMemo(() => tcp.rules ?? [], [tcp.rules])
  const setTcp = useCallback((patch: Partial<MockTcpSpec>) => mutate((s) => ({ ...s, tcp: { ...(s.tcp ?? EMPTY_TCP), ...patch } })), [mutate])

  // 테스트/트래픽 액션은 저장된 mock 을 호출하므로 미저장 편집이 있으면 먼저 저장(권한 없으면 거절)
  const ensureSaved = async (): Promise<boolean> => {
    if (!dirty) return true
    if (!canEdit) { toast('미저장 편집이 있습니다 — 먼저 저장하세요(테스트는 저장된 mock 을 호출합니다).', 'error'); return false }
    try { await save.mutateAsync(); return true } catch { toast('저장 실패 — 미저장 편집을 반영하지 못했습니다.', 'error'); return false }
  }

  // ▶ 노드 만들기 — 이 TCP Mock 을 부르는 워크플로 TCP 노드(연결·요청 레이아웃·응답 필드 거울)를 만든다.
  // 만들어진 노드는 "실제로 서빙되는 정의"의 거울이어야 하므로 두 액션 모두 ensureSaved() 로 미저장 편집을 먼저 반영한다
  // (SPA navigate 는 beforeunload 가드를 타지 않아 미저장 편집이 조용히 버려진다. 저장 못 하면 ensureSaved 가 토스트 후 false).
  const buildTcpNode = () => {
    const rule = tcpRules[0] ?? null
    const n = makeNode('tcp', 300, 120)
    return { ...n, ...mockTcpToNode(tcp, rule, window.location.hostname || 'localhost'), name: `${d?.name ?? 'TCP'} 호출` }
  }
  const copyTcpNode = async () => {
    if (!(await ensureSaved())) return
    try { localStorage.setItem('fl:node-clipboard', JSON.stringify({ nodes: [buildTcpNode()], edges: [] })); toast('TCP 노드를 복사했습니다 — 워크플로 에디터 캔버스에서 Ctrl+V', 'ok') }
    catch { toast('복사 실패(localStorage)', 'error') }
  }
  const newFlowWithTcpNode = async () => {
    if (!(await ensureSaved())) return
    try {
      const start = makeNode('start', 60, 120)
      const tcpNode = buildTcpNode()
      const f = await flowsApi.create({ name: `${d?.name ?? 'TCP'} 호출`, workspaceId: d?.workspaceId ?? 'public' })
      await flowsApi.saveVersion(f.id, { graph: { nodes: [start, tcpNode], edges: [{ id: newId(), from: start.id, to: tcpNode.id, fromPort: 'out' }] }, note: 'TCP Mock 에서 생성' })
      toast(`워크플로 '${f.name}' 을 만들었습니다`, 'ok')
      navigate(`/flows/${f.id}`)
    } catch (e) { toast(apiErrorMessage(e, '워크플로 만들기 실패'), 'error') }
  }

  // Ctrl+S 저장(입력 중에도) · Esc 메뉴 닫기
  const saveRef = useRef<() => void>(() => {})
  useEffect(() => { saveRef.current = () => { if (dirty && canEdit && !save.isPending) save.mutate() } }, [dirty, canEdit, save])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyS' || e.key === 's')) { e.preventDefault(); saveRef.current() }
      if (e.key === 'Escape') setToolsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 미저장 이탈 경고(브라우저 닫기/새로고침)
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])
  // 자동 저장 — dirty 후 1.5초 debounce(워크플로 편집기와 동일)
  useEffect(() => {
    if (!autosave || !canEdit || !dirty || save.isPending) return
    const t = setTimeout(() => saveRef.current(), 1500)
    return () => clearTimeout(t)
  }, [autosave, canEdit, dirty, spec, name, save.isPending])
  useEffect(() => { if (!note?.startsWith('저장됨')) return; const t = setTimeout(() => setNote(null), 2500); return () => clearTimeout(t) }, [note])
  const leave = () => {
    if (!dirty) { navigate('/mocks'); return }
    setAsk({ title: '저장하지 않은 변경', message: '저장하지 않은 편집이 있습니다. 저장하지 않고 나갈까요?', danger: true, confirmLabel: '나가기', onConfirm: () => navigate('/mocks') })
  }

  // 트래픽(요청 기록) — 좌측 목록 히트 수·무매칭 배지·하단 패널 공용. 3초 폴링.
  const reqs = useQuery({ queryKey: ['mock-requests', id], queryFn: () => mocksApi.requests(id), enabled: !!id, refetchInterval: 3000, retry: false })
  const journal = useMemo(() => reqs.data ?? [], [reqs.data])
  const hitsByRoute = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of journal) { if (r.method === 'TCP') continue; const i = findRouteIndex(routes, r.method, r.path); if (i >= 0) m.set(routes[i].id, (m.get(routes[i].id) ?? 0) + 1) }
    return m
  }, [journal, routes])
  const hitsByRule = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of journal) if (r.method === 'TCP' && r.matchedRuleId) m.set(r.matchedRuleId, (m.get(r.matchedRuleId) ?? 0) + 1)
    return m
  }, [journal])
  const unmatched = journal.filter((r) => r.matchedRuleId == null).length

  // ── HTTP 라우트 조작 ──
  const selRoute = nav.kind === 'route' ? routes.find((r) => r.id === nav.id) ?? null : null
  useEffect(() => { if (nav.kind === 'route' && !routes.some((r) => r.id === nav.id)) setNav(routes[0] ? { kind: 'route', id: routes[0].id } : { kind: 'overview' }) }, [routes, nav])
  const addRoute = () => {
    const r: MockRouteSpec = { id: newId(), method: 'GET', path: '/new', rules: [{ id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] }
    mutate((s) => ({ ...s, routes: [...(s.routes ?? []), r] })); setNav({ kind: 'route', id: r.id })
  }
  const setRoute = (rid: string, nr: MockRouteSpec) => mutate((s) => ({ ...s, routes: (s.routes ?? []).map((x) => (x.id === rid ? nr : x)) }))
  const removeRoute = (rid: string) => mutate((s) => ({ ...s, routes: (s.routes ?? []).filter((x) => x.id !== rid) }))
  const dupRoute = (rid: string) => mutate((s) => { const rs = s.routes ?? []; const i = rs.findIndex((x) => x.id === rid); if (i < 0) return s; const src = rs[i]; const copy: MockRouteSpec = { ...src, id: newId(), rules: src.rules.map((u) => ({ ...u, id: newId() })) }; queueMicrotask(() => setNav({ kind: 'route', id: copy.id })); return { ...s, routes: [...rs.slice(0, i + 1), copy, ...rs.slice(i + 1)] } })
  const moveRoute = (rid: string, dir: -1 | 1) => mutate((s) => { const rs = [...(s.routes ?? [])]; const i = rs.findIndex((x) => x.id === rid); const j = i + dir; if (i < 0 || j < 0 || j >= rs.length) return s; const t = rs[i]; rs[i] = rs[j]; rs[j] = t; return { ...s, routes: rs } })
  // ── TCP 규칙 조작 ──
  const selRule = nav.kind === 'rule' ? tcpRules.find((r) => r.id === nav.id) ?? null : null
  useEffect(() => { if (nav.kind === 'rule' && !tcpRules.some((r) => r.id === nav.id)) setNav(tcpRules[0] ? { kind: 'rule', id: tcpRules[0].id } : { kind: 'conn' }) }, [tcpRules, nav])
  const addRule = () => {
    const r: MockTcpRuleSpec = { id: newId(), contains: '', when: [], response: '', responseFields: [{ id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' }] }
    setTcp({ rules: [...tcpRules, r] }); setNav({ kind: 'rule', id: r.id })
  }
  const setRule = (rid: string, patch: Partial<MockTcpRuleSpec>) => mutate((s) => { const t = s.tcp ?? EMPTY_TCP; return { ...s, tcp: { ...t, rules: (t.rules ?? []).map((x) => (x.id === rid ? { ...x, ...patch } : x)) } } })
  const removeRule = (rid: string) => setTcp({ rules: tcpRules.filter((x) => x.id !== rid) })
  const dupRule = (rid: string) => { const i = tcpRules.findIndex((x) => x.id === rid); if (i < 0) return; const src = tcpRules[i]; const copy: MockTcpRuleSpec = { ...src, id: newId(), responseFields: src.responseFields?.map((f) => ({ ...f, id: newId() })) }; setTcp({ rules: [...tcpRules.slice(0, i + 1), copy, ...tcpRules.slice(i + 1)] }); setNav({ kind: 'rule', id: copy.id }) }
  const moveRule = (rid: string, dir: -1 | 1) => { const rs = [...tcpRules]; const i = rs.findIndex((x) => x.id === rid); const j = i + dir; if (i < 0 || j < 0 || j >= rs.length) return; const t = rs[i]; rs[i] = rs[j]; rs[j] = t; setTcp({ rules: rs }) }
  // 드래그 정렬(좌측 목록 — 라우트/규칙 공용)
  const dragId = useRef<string | null>(null)
  const dropOn = (targetId: string) => {
    const from = dragId.current; dragId.current = null
    if (!from || from === targetId) return
    if (isTcp) { const rs = [...tcpRules]; const fi = rs.findIndex((x) => x.id === from); const ti = rs.findIndex((x) => x.id === targetId); if (fi < 0 || ti < 0) return; const [it] = rs.splice(fi, 1); rs.splice(ti, 0, it); setTcp({ rules: rs }); return }
    mutate((s) => { const rs = [...(s.routes ?? [])]; const fi = rs.findIndex((x) => x.id === from); const ti = rs.findIndex((x) => x.id === targetId); if (fi < 0 || ti < 0) return s; const [it] = rs.splice(fi, 1); rs.splice(ti, 0, it); return { ...s, routes: rs } })
  }
  const nq = navQ.trim().toLowerCase()
  const navRoutes = routes.filter((r) => !nq || `${r.method} ${r.path}`.toLowerCase().includes(nq))
  const codecCnt = stepCount(spec.codec)
  const codecActive = codecCnt.request + codecCnt.response > 0
  const sourcesFor = (route?: MockRouteSpec | null) => mockSources({ spec, route, secrets, environment: spec.environment, tcp: isTcp })
  const layoutTotal = (tcp.requestFields ?? []).reduce((a, f) => a + (f.length ?? 0), 0)
  const tcpFieldHints = { request: (tcp.requestFields ?? []).map((f) => f.name ?? '').filter(Boolean), response: [...new Set(tcpRules.flatMap((r) => (r.responseFields ?? []).map((f) => f.name ?? '')).filter(Boolean))] }
  const httpFieldHints = { request: [...new Set(routes.flatMap((r) => (r.expect?.body ?? []).map((f) => f.key)).filter(Boolean))], response: [] as string[] }

  return (
    <AppShellTier1>
      {!d ? (
        <p style={{ color: 'var(--fl-text-muted)', padding: 24 }}>불러오는 중…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 0px)', minHeight: 0 }}>
          {/* ── 헤더 ── */}
          <header style={hdr}>
            <button onClick={leave} title="Mock 목록으로" aria-label="목록으로" style={{ ...ghostBtn, padding: '6px 10px' }}>←</button>
            <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true) }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }}
              disabled={!canEdit} aria-label="이름" style={{ ...input, fontSize: 16, fontWeight: 700, minWidth: 200, maxWidth: 360, background: 'transparent', border: '1px solid transparent' }} />
            <span style={{ ...badge, background: isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-generic)', color: badgeInk }}>{legacyMixed ? 'HTTP Mock · 레거시(TCP 혼합)' : isTcp ? 'TCP Mock' : 'HTTP Mock'}</span>
            <button style={{ ...miniBtn, color: d.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)', opacity: canEdit ? 1 : 0.5 }} disabled={!canEdit} onClick={() => toggle.mutate()} title={d.enabled ? (isTcp ? '리스너 열림 — 클릭하면 닫음' : '서빙 중 — 클릭하면 끔') : '꺼짐 — 클릭하면 켬'}>{d.enabled ? (isTcp ? '● 리스너 열림' : '● 서빙 중') : '○ 꺼짐'}</button>
            {isHttp && (
              <button onClick={() => { void navigator.clipboard?.writeText(base).then(() => toast('base URL 복사됨', 'ok')).catch(() => {}) }} title={`base URL 복사 — ${base}`} style={{ ...miniBtn, fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{base} ⧉</button>
            )}
            {isTcp && (
              <button onClick={() => { const addr = `${window.location.hostname || 'localhost'}:${tcp.port ?? 9091}`; void navigator.clipboard?.writeText(addr).then(() => toast('주소 복사됨', 'ok')).catch(() => {}) }} title="host:port 복사 — 워크플로 TCP 노드 대상" style={{ ...miniBtn, fontFamily: 'var(--fl-font-mono)', fontSize: 11.5 }}>{window.location.hostname || 'localhost'}:{tcp.port ?? 9091} ⧉</button>
            )}
            <span style={{ fontSize: 11.5, color: dirty ? 'var(--fl-put, #f5a623)' : note?.startsWith('저장됨') ? 'var(--fl-ok)' : 'var(--fl-text-muted)', fontWeight: dirty || note?.startsWith('저장됨') ? 700 : 500 }} role="status">
              {save.isPending ? '저장 중…' : dirty ? (autosave ? '● 미저장 (자동 저장 대기)' : '● 미저장') : note?.startsWith('저장됨') ? '✓ 저장됨' : `v${d.currentVersion ?? 0} · ${relTime(d.updatedAt ?? '') || '방금'}`}
            </span>
            {note && !note.startsWith('저장됨') && <span style={{ fontSize: 11.5, color: 'var(--fl-fail)' }}>{note}</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, position: 'relative', alignItems: 'center' }}>
              <button onClick={() => setVersionsOpen(true)} style={ghostBtn} title="버전 기록 — 저장마다 쌓인 정의 스냅샷 열람·비교·복원">🕘 버전</button>
              <button onClick={() => setToolsOpen((v) => !v)} style={ghostBtn} aria-label="도구 메뉴" aria-expanded={toolsOpen}>⋯ 도구</button>
              {toolsOpen && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setToolsOpen(false)} />
                  <div style={toolsMenu} role="menu">
                    {canEdit && <button style={toolItem} onClick={() => { duplicate.mutate(); setToolsOpen(false) }}>⧉ 이 Mock 복제</button>}
                    {isTcp && canEdit && <button style={toolItem} onClick={() => { void newFlowWithTcpNode(); setToolsOpen(false) }}>▶ 이 Mock 을 부르는 TCP 노드 만들기 (새 워크플로)</button>}
                    {isTcp && <button style={toolItem} onClick={() => { void copyTcpNode(); setToolsOpen(false) }}>⧉ TCP 노드 복사 (에디터에서 Ctrl+V)</button>}
                    <button style={toolItem} onClick={() => { setJsonOpen(true); setToolsOpen(false) }}>{'{ } 정의 JSON 보기'}</button>
                    <button style={toolItem} onClick={() => { setTransfer('export'); setToolsOpen(false) }}>⬆ 내보내기(복사)</button>
                    {canEdit && <button style={toolItem} onClick={() => { setTransfer('import'); setToolsOpen(false) }}>⬇ 가져오기(덮어쓰기)</button>}
                    {canEdit && <button style={toolItem} onClick={() => { reset.mutate(); setToolsOpen(false) }}>↺ 상태·요청 기록 초기화</button>}
                    {canEdit && <button style={toolItem} onClick={() => { setAutosave((v) => { try { localStorage.setItem('fl:mock:autosave', v ? '0' : '1') } catch { /* */ } return !v }); setToolsOpen(false) }}>{autosave ? '☑ 자동 저장 켜짐' : '☐ 자동 저장'}</button>}
                    <button style={toolItem} onClick={() => { setNav({ kind: 'settings' }); setToolsOpen(false) }}>⚙ 설정(slug · 시크릿 환경 · 삭제)</button>
                    <button style={toolItem} onClick={() => { setShortcutsOpen(true); setToolsOpen(false) }}>⌨ 단축키 도움말</button>
                  </div>
                </>
              )}
              {canEdit && <button style={{ ...ghostBtn, border: '1px solid var(--fl-primary)', color: 'var(--fl-primary)' }} title={isHttp ? 'AI 로 mock 만들기/고치기' : 'AI 로 TCP 전문 mock(레이아웃·규칙·응답 필드) 만들기/고치기'} onClick={() => setAiOpen((v) => !v)}>✨ AI</button>}
              <button style={{ ...primaryBtn, opacity: dirty && canEdit ? 1 : 0.55 }} disabled={!dirty || save.isPending || !canEdit} title={canEdit ? '저장 (Ctrl+S)' : 'viewer 역할은 저장할 수 없습니다'} onClick={() => save.mutate()}>💾 저장</button>
            </div>
          </header>

          {/* ── 본문: 좌 목록 | 우 상세 ── */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <nav style={leftNav} aria-label="Mock 구성">
              {isHttp && (
                <>
                  <div style={navHead}>
                    <span>라우트 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}>{routes.length}</span></span>
                    {canEdit && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={addRoute} title="라우트 추가">+</button>}
                  </div>
                  {routes.length >= 6 && <input value={navQ} onChange={(e) => setNavQ(e.target.value)} placeholder="라우트 검색…" aria-label="라우트 검색" style={{ ...input, width: '100%', boxSizing: 'border-box', margin: '0 0 6px', padding: '5px 9px', fontSize: 12 }} />}
                  <div style={{ display: 'grid', gap: 2 }}>
                    {navRoutes.map((r) => {
                      const active = nav.kind === 'route' && nav.id === r.id
                      const hits = hitsByRoute.get(r.id) ?? 0
                      return (
                        <button key={r.id} onClick={() => setNav({ kind: 'route', id: r.id })} draggable={canEdit} onDragStart={() => { dragId.current = r.id }} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(r.id)}
                          style={{ ...navItem, ...(active ? navActive : null) }} title={`${r.method} ${r.path}${hits ? ` · 요청 ${hits}` : ''}`}>
                          <span style={{ ...mchip, color: methodColor(r.method) }}>{r.method}</span>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--fl-font-mono)', fontSize: 12 }}>{r.path}</span>
                          {r.codec && <span title="이 라우트만 코덱" style={{ fontSize: 9.5, color: 'var(--fl-primary)' }}>◈</span>}
                          {hits > 0 && <span style={hitBadge} title={`요청 기록 ${hits}건`}>{hits}</span>}
                        </button>
                      )
                    })}
                    {routes.length === 0 && <div style={{ fontSize: 12, color: 'var(--fl-text-muted)', padding: '6px 8px' }}>라우트 없음</div>}
                  </div>
                  <div style={divider} />
                  <button onClick={() => setNav({ kind: 'codec' })} style={{ ...navItem, ...(nav.kind === 'codec' ? navActive : null) }}>
                    <span aria-hidden>◈</span><span style={{ flex: 1 }}>본문·헤더 코덱</span>{codecActive && <span style={{ ...hitBadge, background: 'var(--fl-primary)', color: '#fff' }}>{codecCnt.request + codecCnt.response}</span>}
                  </button>
                </>
              )}
              {isTcp && (
                <>
                  <button onClick={() => setNav({ kind: 'conn' })} style={{ ...navItem, ...(nav.kind === 'conn' ? navActive : null) }}>
                    <span aria-hidden>🔌</span><span style={{ flex: 1 }}>연결</span><span style={metaMono}>:{tcp.port ?? '?'} · {tcp.charset ?? 'EUC-KR'}</span>
                  </button>
                  <button onClick={() => setNav({ kind: 'layout' })} style={{ ...navItem, ...(nav.kind === 'layout' ? navActive : null) }}>
                    <span aria-hidden>⬇</span><span style={{ flex: 1 }}>요청 레이아웃</span><span style={metaMono}>{(tcp.requestFields ?? []).length}필드 · {layoutTotal}B</span>
                  </button>
                  <div style={divider} />
                  <div style={navHead}>
                    <span>규칙 <span style={{ fontWeight: 400, color: 'var(--fl-text-muted)' }}>{tcpRules.length}</span></span>
                    {canEdit && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={addRule} title="규칙 추가">+</button>}
                  </div>
                  <div style={{ display: 'grid', gap: 2 }}>
                    {tcpRules.map((r, i) => {
                      const active = nav.kind === 'rule' && nav.id === r.id
                      const hits = hitsByRule.get(r.id) ?? 0
                      const summary = tcpRuleSummary(r)
                      return (
                        <button key={r.id} onClick={() => setNav({ kind: 'rule', id: r.id })} draggable={canEdit} onDragStart={() => { dragId.current = r.id }} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(r.id)}
                          style={{ ...navItem, ...(active ? navActive : null), alignItems: 'flex-start' }} title={`규칙 ${i + 1} — ${summary}${hits ? ` · 요청 ${hits}` : ''}`}>
                          <span style={{ ...mchip, color: 'var(--fl-cat-tcp, #7c5cff)', minWidth: 28 }}>#{i + 1}</span>
                          <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 1 }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{summary}</span>
                            <span style={{ ...metaMono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(r.responseFields?.length ?? 0) > 0 ? `응답 ${r.responseFields!.length}필드 · ${r.responseFields!.reduce((a, f) => a + (f.length ?? 0), 0)}B` : r.response ? '응답 텍스트' : '응답 없음'}</span>
                          </span>
                          {hits > 0 && <span style={hitBadge} title={`요청 기록 ${hits}건`}>{hits}</span>}
                        </button>
                      )
                    })}
                    {tcpRules.length === 0 && <div style={{ fontSize: 12, color: 'var(--fl-text-muted)', padding: '6px 8px' }}>규칙 없음 — 모든 전문에 빈 응답</div>}
                  </div>
                  <div style={divider} />
                  <button onClick={() => setNav({ kind: 'codec' })} style={{ ...navItem, ...(nav.kind === 'codec' ? navActive : null) }}>
                    <span aria-hidden>◈</span><span style={{ flex: 1 }}>전문 코덱</span>{codecActive && <span style={{ ...hitBadge, background: 'var(--fl-primary)', color: '#fff' }}>{codecCnt.request + codecCnt.response}</span>}
                  </button>
                </>
              )}
              <button onClick={() => setNav({ kind: 'settings' })} style={{ ...navItem, ...(nav.kind === 'settings' ? navActive : null) }}>
                <span aria-hidden>⚙</span><span style={{ flex: 1 }}>설정</span>{spec.environment && <span style={metaMono}>🔑 {spec.environment}</span>}
              </button>
              {isHttp && <button onClick={() => setNav({ kind: 'overview' })} style={{ ...navItem, ...(nav.kind === 'overview' ? navActive : null) }}><span aria-hidden>☰</span><span style={{ flex: 1 }}>개요 · 시작하기</span></button>}
            </nav>

            <section style={rightPane} aria-label="상세">
              {legacyMixed && (
                <div style={legacyBanner} role="note">
                  <span style={{ fontSize: 16 }}>⚠</span>
                  <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.5 }}>
                    <b>HTTP 라우트와 TCP 전문이 함께 있는 예전 형식</b>입니다. 이제 HTTP 와 TCP 는 따로 관리합니다 — TCP 부분(포트 {spec.tcp?.port ?? '?'} · 규칙 {spec.tcp?.rules?.length ?? 0})을 새 TCP Mock 으로 옮기면 이 Mock 은 HTTP 만 남습니다. 옮기기 전까지 TCP 리스너는 그대로 동작합니다.
                  </span>
                  {canEdit && <button style={{ ...primaryBtn, padding: '6px 12px', fontSize: 12 }} disabled={splitTcp.isPending} onClick={() => setAsk({ title: 'TCP Mock 으로 분리', message: `TCP 부분을 새 Mock '${d.name} (TCP)' 으로 옮기고 이 Mock 은 HTTP 만 남깁니다. 미저장 편집은 함께 저장됩니다. 진행할까요?`, confirmLabel: '분리', onConfirm: () => splitTcp.mutate() })}>{splitTcp.isPending ? '분리 중…' : 'TCP Mock 으로 분리'}</button>}
                </div>
              )}
              {nav.kind === 'route' && selRoute && (
                <RouteCard key={selRoute.id} base={base} ensureSaved={ensureSaved} mockId={id} spec={spec} secrets={secrets} route={selRoute} readOnly={!canEdit}
                  onChange={(nr) => setRoute(selRoute.id, nr)} onRemove={() => removeRoute(selRoute.id)} onDup={() => dupRoute(selRoute.id)} onUp={() => moveRoute(selRoute.id, -1)} onDown={() => moveRoute(selRoute.id, 1)}
                  onServerCodec={(codec) => mutate((s) => ({ ...s, codec }))} onGoCodec={() => setNav({ kind: 'codec' })} />
              )}
              {nav.kind === 'conn' && (
                <>
                  {tcp.enabled === false && (
                    <div style={{ ...legacyBanner, marginBottom: 12 }} role="note">
                      <span style={{ fontSize: 16 }}>○</span>
                      <span style={{ flex: 1, fontSize: 12.5 }}><b>리스너가 꺼져 있습니다</b>(복제본은 포트 충돌을 막으려 꺼서 만듭니다). 포트를 확인하고 켜세요 — 저장하면 열립니다.</span>
                      {canEdit && <button style={{ ...primaryBtn, padding: '6px 12px', fontSize: 12 }} onClick={() => setTcp({ enabled: true })}>리스너 켜기</button>}
                    </div>
                  )}
                  <TcpConnectionPanel tcp={tcp} readOnly={!canEdit} onChange={setTcp} />
                </>
              )}
              {nav.kind === 'layout' && (
                <TcpLayoutPanel tcp={tcp} readOnly={!canEdit} onChange={setTcp} codec={spec.codec} onCodec={(codec) => mutate((s) => ({ ...s, codec }))} sources={sourcesFor(null)} />
              )}
              {nav.kind === 'rule' && selRule && (
                <TcpRuleDetail key={selRule.id} rule={selRule} index={tcpRules.findIndex((r) => r.id === selRule.id)} total={tcpRules.length} layout={tcp.requestFields ?? []} readOnly={!canEdit} sources={sourcesFor(null)}
                  codec={spec.codec} onCodec={(codec) => mutate((s) => ({ ...s, codec }))} tcpCharset={tcp.charset ?? 'EUC-KR'}
                  onChange={(patch) => setRule(selRule.id, patch)} onMove={(dir) => moveRule(selRule.id, dir)} onDup={() => dupRule(selRule.id)} onRemove={() => removeRule(selRule.id)} />
              )}
              {nav.kind === 'codec' && (
                <section style={panel}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h2 style={h2}>{isTcp ? '전문 코덱' : '본문·헤더 코덱'} <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>(플러그인 — 요청 전 · 응답 후)</span></h2>
                    {codecActive && <span style={{ ...badge, background: 'var(--fl-primary)' }}>사용 중</span>}
                  </div>
                  <p style={hint}>
                    {isTcp ? '들어온 전문' : '요청 본문'}이 <b>매칭·템플릿에 들어가기 전</b>에 풀고(예: Base64 디코딩·AES 복호화), 응답을 <b>다 만든 뒤 나가기 전</b>에 감쌉니다(예: 인코딩·HMAC 서명).
                    단계마다 무엇을(전체/특정 필드/헤더)·어떤 플러그인·값(키·IV 는 <code style={code}>{'{{ 이름@secret }}'}</code>)을 정합니다.
                    {isTcp ? ' 필드 하나만 걸 때는 요청 레이아웃·규칙 응답 필드 옆 ◈ 가 더 빠릅니다.' : ' 필드 하나만 걸 때는 라우트의 예상 요청·응답 필드 옆 ◈ 가 더 빠릅니다. 라우트별로 다른 코덱은 라우트 상세의 [이 라우트만 코덱].'}
                  </p>
                  <div style={{ marginTop: 12 }}>
                    <MockCodecEditor codec={spec.codec} readOnly={!canEdit} kind={isTcp ? 'tcp' : 'http'} mockId={id} environment={spec.environment}
                      sources={sourcesFor(null)} fieldHints={isTcp ? tcpFieldHints : httpFieldHints}
                      onChange={(codec) => mutate((s) => ({ ...s, codec }))} />
                  </div>
                </section>
              )}
              {nav.kind === 'settings' && (
                <section style={panel}>
                  <h2 style={h2}>설정</h2>
                  <div style={{ display: 'grid', gap: 14, marginTop: 12 }}>
                    <div>
                      <div style={lbl}>{isTcp ? '리스너 주소' : '서빙 주소'}</div>
                      {isHttp && <div style={{ display: 'flex', gap: 6 }}><input readOnly value={base} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} /><button style={miniBtn} onClick={() => { void navigator.clipboard?.writeText(base).then(() => toast('복사됨', 'ok')).catch(() => {}) }}>⧉ 복사</button></div>}
                      {isTcp && <div style={{ display: 'flex', gap: 6 }}><input readOnly value={`${window.location.hostname || 'localhost'}:${tcp.port ?? 9091}`} onFocus={(e) => e.currentTarget.select()} style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }} /><button style={miniBtn} onClick={() => setNav({ kind: 'conn' })}>포트 바꾸기 →</button></div>}
                      <div style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 4 }}>slug <code style={code}>{d.slug}</code> 는 {isHttp ? '서빙 주소라' : '식별자라'} 바꿀 수 없습니다(전역 유일). 다른 {isHttp ? '주소' : 'slug'}가 필요하면 [⋯ 도구 → 복제]로 새 slug 를 만드세요. {isHttp ? '서빙은 무인증(외부 시스템이 호출하는 대상).' : '리스너는 무인증(사내망 전제).'}</div>
                    </div>
                    <div>
                      <div style={lbl}>🔑 시크릿 환경</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select style={{ ...input, minWidth: 160 }} value={spec.environment ?? ''} disabled={!canEdit} onChange={(e) => mutate((s) => ({ ...s, environment: e.target.value || null }))} title="{{ 이름@secret }} 해석 스코프 — 공통 시크릿(+Vault)에 이 환경의 시크릿을 덮어씀">
                          <option value="">공통만</option>
                          {secretEnvs.map((e) => <option key={e} value={e}>{e}</option>)}
                          {spec.environment && !secretEnvs.includes(spec.environment) && <option value={spec.environment}>{spec.environment}</option>}
                        </select>
                        <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)' }}>{secrets.length ? `적용 가능한 시크릿 ${secrets.filter((x) => !x.environment || x.environment === (spec.environment ?? null)).length}개 — 값 칸에서 { } 로 삽입` : '시크릿 없음 — 워크플로 편집기 도구 → 시크릿 볼트에서 추가'}</span>
                      </div>
                    </div>
                    {isHttp && canEdit && (
                      <div>
                        <div style={lbl}>라우트 자동 생성</div>
                        <OpenApiImportBox onRoutes={(generated) => { mutate((s) => ({ ...s, routes: [...(s.routes ?? []), ...generated] })); setNav({ kind: 'route', id: generated[0].id }) }} />
                      </div>
                    )}
                    <div>
                      <div style={lbl}>정의 이동</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button style={miniBtn} onClick={() => setTransfer('export')}>⬆ 내보내기(복사)</button>
                        {canEdit && <button style={miniBtn} onClick={() => setTransfer('import')}>⬇ 가져오기(덮어쓰기)</button>}
                        <button style={miniBtn} onClick={() => setVersionsOpen(true)}>🕘 버전 기록</button>
                      </div>
                    </div>
                    {canEdit && (
                      <div style={{ borderTop: '1px solid var(--fl-border)', paddingTop: 12 }}>
                        <div style={{ ...lbl, color: 'var(--fl-fail)' }}>위험 구역</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button style={miniBtn} onClick={() => reset.mutate()} title="state·seq·hits·요청 기록 초기화">↺ 상태·요청 기록 초기화</button>
                          <button style={{ ...miniBtn, color: 'var(--fl-fail)' }} onClick={() => setAsk({ title: 'Mock 서버 삭제', danger: true, confirmLabel: '삭제', message: `'${d.name}' 을 삭제할까요? 이 Mock 을 호출하는 워크플로는 실패하게 됩니다. 되돌릴 수 없습니다.`, onConfirm: () => { void mocksApi.remove(id).then(() => { toast('삭제했습니다.', 'ok'); qc.invalidateQueries({ queryKey: ['mock-servers'] }); navigate('/mocks') }).catch((e) => toast(apiErrorMessage(e, '삭제 실패'), 'error')) } })}>🗑 이 Mock 삭제</button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}
              {nav.kind === 'overview' && (
                <section style={panel}>
                  <h2 style={h2}>{routes.length ? '개요' : '첫 라우트를 만들어 보세요'}</h2>
                  <p style={hint}>왼쪽 목록에서 라우트를 고르면 오른쪽에서 예상 요청·규칙·코덱을 편집합니다(라우트 = 노드, 상세 = 속성 패널). 아래 트래픽 패널에는 실제 요청이 실시간으로 쌓입니다.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 12 }}>
                    {canEdit && <button style={tile} onClick={addRoute}><b>+ 라우트 추가</b><span>메서드·경로·응답 규칙을 직접 정의</span></button>}
                    {canEdit && <button style={tile} onClick={() => setNav({ kind: 'settings' })}><b>OpenAPI 에서 생성</b><span>Swagger/OpenAPI JSON 을 붙여넣어 라우트 자동 생성</span></button>}
                    {canEdit && <button style={tile} onClick={() => setAiOpen(true)}><b>✨ AI 로 만들기</b><span>"결제 승인 mock 만들어줘" 처럼 말로</span></button>}
                    <button style={tile} onClick={() => setTrafficOpen(true)}><b>요청 기록에서 만들기</b><span>워크플로가 먼저 호출하게 두고, 기록의 [규칙 초안]으로 라우트를 만든다{unmatched ? ` — 무매칭 ${unmatched}건 대기 중` : ''}</span></button>
                  </div>
                  {routes.length > 0 && (
                    <div style={{ marginTop: 16, display: 'grid', gap: 4 }}>
                      {routes.map((r) => (
                        <button key={r.id} onClick={() => setNav({ kind: 'route', id: r.id })} style={{ ...navItem, border: '1px solid var(--fl-border)' }}>
                          <span style={{ ...mchip, color: methodColor(r.method) }}>{r.method}</span>
                          <span style={{ flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }}>{r.path}</span>
                          <span style={metaMono}>규칙 {r.rules.length}{r.codec ? ' · 코덱' : ''}{(hitsByRoute.get(r.id) ?? 0) ? ` · 요청 ${hitsByRoute.get(r.id)}` : ''}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </section>
          </div>

          {/* ── 하단 트래픽 패널 ── */}
          <TrafficPanel id={id} canEdit={canEdit} base={base} spec={spec} onSpec={mutate} journal={journal} open={trafficOpen}
            onToggle={() => setTrafficOpen((v) => { try { localStorage.setItem('fl:mock:traffic', v ? '0' : '1') } catch { /* */ } return !v })}
            tab={trafficTab} onTab={setTrafficTab}
            routeFilter={selRoute} ensureSaved={ensureSaved} isTcp={isTcp} tcp={tcp} tcpRules={tcpRules}
            onSelectRoute={(rid) => setNav({ kind: 'route', id: rid })} onSelectRule={(rid) => setNav({ kind: 'rule', id: rid })} unmatched={unmatched}
            previewSample={previewSample} onPreviewSample={setPreviewSample} />

          {aiOpen && (isGuest || aiPending
            ? <AssistantLoginGate reason={isGuest ? 'guest' : 'pending'} variant="overlay" onClose={() => setAiOpen(false)} />
            : <MockAssistantPanel spec={spec} mockId={id} onApply={(newSpec) => mutate(() => newSpec)} onClose={() => setAiOpen(false)} />)}
          {transfer === 'export' && <MockExportDialog mock={d} spec={spec} onClose={() => setTransfer(null)} />}
          {transfer === 'import' && <MockReplaceSpecDialog onClose={() => setTransfer(null)} onReplace={(newSpec, warnings) => { mutate(() => newSpec); toast(`정의를 교체했습니다 — 저장하면 반영됩니다.${warnings.length ? ' ' + warnings.join(' ') : ''}`, warnings.length ? 'info' : 'ok') }} />}
          {versionsOpen && <MockVersionHistoryDialog mockId={id} currentSpec={spec} readOnly={!canEdit} onClose={() => setVersionsOpen(false)} onRestored={() => { setDirty(false); invalidate() }} />}
          {jsonOpen && (
            <Modal onClose={() => setJsonOpen(false)} ariaLabel="정의 JSON" width={720}>
              <div style={{ padding: 18, display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><strong style={{ flex: 1 }}>정의 JSON (현재 편집 중)</strong><button style={miniBtn} onClick={() => { void navigator.clipboard?.writeText(JSON.stringify(spec, null, 2)).then(() => toast('복사됨', 'ok')) }}>⧉ 복사</button><button style={miniBtn} onClick={() => setJsonOpen(false)}>닫기</button></div>
                <pre style={{ margin: 0, padding: 12, fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 6, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{JSON.stringify(spec, null, 2)}</pre>
              </div>
            </Modal>
          )}
          {shortcutsOpen && (
            <Modal onClose={() => setShortcutsOpen(false)} ariaLabel="단축키" width={420}>
              <div style={{ padding: 18, display: 'grid', gap: 6, fontSize: 13 }}>
                <strong>단축키</strong>
                <div><kbd style={kbd}>Ctrl+S</kbd> 저장</div>
                <div><kbd style={kbd}>Esc</kbd> 메뉴/모달 닫기</div>
                <div><kbd style={kbd}>Enter</kbd> 이름 확정 · 보내보기 전송 · 미리보기</div>
                <div style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>좌측 {isTcp ? '규칙' : '라우트'}은 드래그로 순서를 바꿀 수 있습니다(위→아래 첫 매칭).</div>
                <button style={{ ...miniBtn, justifySelf: 'end' }} onClick={() => setShortcutsOpen(false)}>닫기</button>
              </div>
            </Modal>
          )}
          {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
        </div>
      )}
    </AppShellTier1>
  )
}

// ---------- OpenAPI 가져오기 ----------

function OpenApiImportBox({ onRoutes }: { onRoutes: (r: MockRouteSpec[]) => void }) {
  const [text, setText] = useState('')
  return (
    <div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="OpenAPI 3 / Swagger 2 JSON 을 붙여넣으세요… (path+method 마다 첫 성공 응답 예시로 규칙 1개)"
        style={{ ...input, width: '100%', minHeight: 80, fontFamily: 'var(--fl-font-mono)', fontSize: 12, boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button style={{ ...miniBtn, color: 'var(--fl-primary)' }} disabled={!text.trim()} onClick={() => {
          const generated = openApiToMockRoutes(text)
          if (!generated.length) { toast('라우트를 추출하지 못했습니다 — 유효한 OpenAPI/Swagger JSON 인지 확인하세요.', 'error'); return }
          onRoutes(generated); setText(''); toast(`라우트 ${generated.length}개를 생성했습니다.`, 'ok')
        }}>라우트 생성</button>
      </div>
    </div>
  )
}

// ---------- 트래픽 패널(요청 기록 실시간 + 보내보기 / TCP 미리보기) ----------

function TrafficPanel({ id, canEdit, base, spec, onSpec, journal, open, onToggle, tab, onTab, routeFilter, ensureSaved, isTcp, tcp, tcpRules, onSelectRoute, onSelectRule, unmatched, previewSample, onPreviewSample }: {
  id: string; canEdit: boolean; base: string; spec: MockServerSpec; onSpec: (fn: (s: MockServerSpec) => MockServerSpec) => void
  journal: MockRequestLog[]; open: boolean; onToggle: () => void; tab: 'log' | 'send' | 'preview'; onTab: (t: 'log' | 'send' | 'preview') => void
  routeFilter: MockRouteSpec | null; ensureSaved: () => Promise<boolean>; isTcp: boolean; tcp: MockTcpSpec; tcpRules: MockTcpRuleSpec[]
  onSelectRoute: (routeId: string) => void; onSelectRule: (ruleId: string) => void; unmatched: number
  previewSample: string; onPreviewSample: (s: string) => void
}) {
  const qc = useQueryClient()
  const [onlyRoute, setOnlyRoute] = useState(false)
  const [openReq, setOpenReq] = useState<number | null>(null)
  const st = useQuery({ queryKey: ['mock-state', id], queryFn: () => mocksApi.state(id), enabled: open && !isTcp, refetchInterval: open && !isTcp ? 3000 : false, retry: false })
  const clear = useMutation({ mutationFn: () => mocksApi.clearRequests(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['mock-requests', id] }) })
  const routes = useMemo(() => spec.routes ?? [], [spec.routes])
  const shown = useMemo(() => (onlyRoute && routeFilter ? journal.filter((r) => { const i = findRouteIndex(routes, r.method, r.path); return i >= 0 && routes[i].id === routeFilter.id }) : journal), [journal, onlyRoute, routeFilter, routes])
  const expectFrom = (r: MockRequestLog) => {
    const idx = findRouteIndex(routes, r.method, r.path)
    if (idx < 0) { toast('이 요청에 맞는 라우트가 없습니다 — [규칙 초안]으로 라우트부터 만드세요.', 'error'); return }
    const add = { body: bodyKeys(r.decodedBody ?? r.bodyText), query: r.query, header: interestingHeaders(r.headers) }
    onSpec((s) => ({ ...s, routes: (s.routes ?? []).map((x, i) => (i === idx ? { ...x, expect: mergeExpect(x.expect, add) } : x)) }))
    toast(`라우트 ${routes[idx].method} ${routes[idx].path} 의 예상 요청에 ${Object.keys(add.body).length + Object.keys(add.query).length + Object.keys(add.header).length}개 필드를 반영했습니다.`, 'ok')
    onSelectRoute(routes[idx].id)
  }
  const draftRule = (r: MockRequestLog) => {
    const idx = findRouteIndex(routes, r.method, r.path)
    const body = bodyKeys(r.decodedBody ?? r.bodyText)
    const add = { body, query: r.query, header: interestingHeaders(r.headers) }
    const conds = [...Object.entries(body).slice(0, 3).map(([k, v]) => ({ source: 'body' as const, key: k, op: 'eq' as const, value: v })), ...Object.entries(r.query).slice(0, 2).map(([k, v]) => ({ source: 'query' as const, key: k, op: 'eq' as const, value: v }))]
    if (idx < 0) {
      const route: MockRouteSpec = { id: newId(), method: r.method, path: r.path, expect: mergeExpect(null, add), rules: [{ id: newId(), status: 200, contentType: 'json', body: '{"ok":true}' }] }
      onSpec((s) => ({ ...s, routes: [...(s.routes ?? []), route] }))
      toast(`라우트 ${r.method} ${r.path} 를 만들었습니다(기본 규칙 + 예상 요청). 저장하면 반영됩니다.`, 'ok')
      onSelectRoute(route.id)
      return
    }
    onSpec((s) => ({ ...s, routes: (s.routes ?? []).map((x, i) => (i === idx ? { ...x, expect: mergeExpect(x.expect, add), rules: [{ id: newId(), when: conds, status: 200, contentType: 'json', body: '{"ok":true}' }, ...x.rules] } : x)) }))
    toast(`라우트 ${routes[idx].method} ${routes[idx].path} 위에 조건 ${conds.length}개짜리 규칙 초안을 추가했습니다.`, 'ok')
    onSelectRoute(routes[idx].id)
  }
  const replay = async (r: MockRequestLog) => {
    const qs = Object.entries(r.query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    const hasBody = r.method !== 'GET' && r.method !== 'HEAD'
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.headers)) if (!['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) headers[k] = v
    try {
      const res = await fetch(base + r.path + (qs ? `?${qs}` : ''), { method: r.method, headers, body: hasBody ? r.bodyText : undefined })
      toast(`재전송 → HTTP ${res.status}`, res.ok ? 'ok' : 'error')
      qc.invalidateQueries({ queryKey: ['mock-requests', id] })
    } catch (e) { toast(`재전송 실패: ${(e as Error).message}`, 'error') }
  }
  const stateKeys = Object.keys(st.data?.state ?? {})
  const tabs: Array<['log' | 'send' | 'preview', string]> = isTcp ? [['log', '전문 기록'], ['preview', '🔍 전문 미리보기']] : [['log', '요청 기록'], ['send', '보내보기']]
  return (
    <section style={{ ...trafficWrap, height: open ? 300 : 36 }} aria-label="트래픽 패널">
      <div style={trafficBar}>
        <button style={{ ...miniBtn, fontWeight: 700, border: 'none', background: 'transparent' }} onClick={onToggle} aria-expanded={open}>{open ? '▾' : '▸'} 트래픽</button>
        <span style={metaMono}>{isTcp ? '전문' : '요청'} 기록 {journal.length}{unmatched ? ` · 무매칭 ${unmatched}` : ''}{stateKeys.length ? ` · 상태 ${stateKeys.length}` : ''}{st.data ? ` · seq ${st.data.seq}` : ''}</span>
        {open && (
          <div style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden', marginLeft: 8 }}>
            {tabs.map(([t, label]) => (
              <button key={t} onClick={() => onTab(t)} style={{ padding: '3px 10px', border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, background: tab === t ? 'var(--fl-primary)' : 'transparent', color: tab === t ? '#fff' : 'var(--fl-text-muted)' }}>{label}</button>
            ))}
          </div>
        )}
        {open && tab === 'log' && !isTcp && routeFilter && <label style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}><input type="checkbox" checked={onlyRoute} onChange={(e) => setOnlyRoute(e.target.checked)} />선택한 라우트만</label>}
        <span style={{ marginLeft: 'auto' }} />
        {open && stateKeys.length > 0 && <span style={{ ...metaMono, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={stateKeys.map((k) => `${k}=${st.data!.state[k]}`).join(' · ')}>{stateKeys.map((k) => `${k}=${st.data!.state[k]}`).join(' · ')}</span>}
        {open && canEdit && journal.length > 0 && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => clear.mutate()}>기록 비우기</button>}
      </div>
      {open && tab === 'log' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px 10px' }}>
          {shown.length === 0 ? <div style={{ fontSize: 12, color: 'var(--fl-text-muted)', padding: '8px 0' }}>{journal.length ? '선택한 라우트로 온 요청이 없습니다.' : `아직 ${isTcp ? '전문' : '요청'}이 없습니다 — ${isTcp ? '워크플로 TCP 노드가 이 포트로 전문을 보내면 여기에 기록됩니다. 소켓 없이 확인하려면 [🔍 전문 미리보기].' : 'base URL 을 워크플로 HTTP 노드에 넣고 실행하거나 [보내보기]로 호출해 보세요.'}`}</div>
            : <div style={{ display: 'grid', gap: 3 }}>{shown.map((r, i) => {
                const isTcpRow = r.method === 'TCP'
                const ri = isTcpRow ? -1 : findRouteIndex(routes, r.method, r.path)
                const ruleIdx = isTcpRow && r.matchedRuleId ? tcpRules.findIndex((x) => x.id === r.matchedRuleId) : -1
                return (
                  <div key={`${r.at}-${i}`} style={{ border: '1px solid var(--fl-border)', borderRadius: 6, overflow: 'hidden', borderLeft: `3px solid ${r.matchedRuleId == null ? 'var(--fl-fail)' : 'var(--fl-border)'}` }}>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 10px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--fl-text)' }} onClick={() => setOpenReq(openReq === i ? null : i)}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: isTcpRow ? 'var(--fl-cat-tcp, #7c5cff)' : methodColor(r.method), minWidth: 44 }}>{r.method}</span>
                      {isTcpRow
                        ? <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.bodyText}>{r.bodyText || '(빈 전문)'}</code>
                        : <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.path}{Object.keys(r.query).length ? '?' + Object.entries(r.query).map(([k, v]) => `${k}=${v}`).join('&') : ''}</code>}
                      {isTcpRow && <span style={metaMono}>{r.headers.bytes ?? '?'}B → {r.headers['response-bytes'] ?? '?'}B</span>}
                      {ri >= 0 && <span style={{ ...metaMono, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onSelectRoute(routes[ri].id) }} title="이 라우트 열기">{routes[ri].path}</span>}
                      {ruleIdx >= 0 && <span style={{ ...metaMono, cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); onSelectRule(tcpRules[ruleIdx].id) }} title="이 규칙 열기">규칙 {ruleIdx + 1}</span>}
                      {!isTcpRow && <span style={{ fontSize: 11, color: r.status >= 400 ? 'var(--fl-fail)' : 'var(--fl-ok)', fontFamily: 'var(--fl-font-mono)' }}>{r.status}</span>}
                      {r.matchedRuleId == null && <span style={{ fontSize: 10, color: 'var(--fl-fail)', fontWeight: 700 }}>무매칭</span>}
                      <span style={metaMono}>{relTime(r.at)}</span>
                    </button>
                    {openReq === i && (
                      <div style={{ padding: '0 10px 8px', display: 'grid', gap: 5 }}>
                        {!isTcpRow && Object.keys(r.headers).length > 0 && <pre style={reqPre}>{Object.entries(interestingHeaders(r.headers)).map(([k, v]) => `${k}: ${v}`).join('\n') || '(표준 헤더만)'}</pre>}
                        {r.bodyText && <pre style={reqPre}>{isTcpRow ? '전문: ' : 'body: '}{r.bodyText}</pre>}
                        {r.decodedBody != null && <pre style={{ ...reqPre, borderLeft: '3px solid var(--fl-primary)' }}>코덱 적용 후: {r.decodedBody}</pre>}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{r.matchedRuleId ? (isTcpRow ? `규칙 ${ruleIdx + 1}` : `규칙 ${r.matchedRuleId}`) : `매칭 규칙 없음${isTcpRow ? '(빈 응답)' : '(404)'}`}{r.callbackFired ? ' · 콜백 발사' : ''}{r.delayMs ? ` · 지연 ${r.delayMs}ms` : ''}</span>
                          {!isTcpRow && canEdit && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => expectFrom(r)} title="이 요청의 본문/쿼리/헤더 키를 라우트의 예상 요청 필드로">예상 필드로</button>}
                          {!isTcpRow && canEdit && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => draftRule(r)} title="이 요청에 맞는 라우트/규칙 초안(요청 값 eq 조건)">규칙 초안</button>}
                          {!isTcpRow && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => { void replay(r) }} title="같은 요청을 다시 보냅니다">재전송</button>}
                          {isTcpRow && <button style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => { onPreviewSample(r.bodyText); onTab('preview') }} title="이 전문을 샘플로 미리보기(미저장 편집 반영)">🔍 이 전문으로 미리보기</button>}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}</div>}
        </div>
      )}
      {open && tab === 'send' && <SendBox base={base} ensureSaved={ensureSaved} routeFilter={routeFilter} onSent={() => qc.invalidateQueries({ queryKey: ['mock-requests', id] })} />}
      {open && tab === 'preview' && <TcpPreviewPanel tcp={tcp} codec={spec.codec} environment={spec.environment} onSelectRule={onSelectRule} sample={previewSample} onSample={onPreviewSample} />}
    </section>
  )
}

function SendBox({ base, ensureSaved, routeFilter, onSent }: { base: string; ensureSaved: () => Promise<boolean>; routeFilter: MockRouteSpec | null; onSent: () => void }) {
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/')
  const [body, setBody] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (routeFilter) { setMethod(routeFilter.method === 'ANY' ? 'POST' : routeFilter.method); setPath(routeFilter.path.replace(/\{[^}/]+\}/g, '1')) } }, [routeFilter])
  const send = async () => {
    if (!(await ensureSaved())) return
    setBusy(true); setResult(null)
    try {
      const res = await fetch(base + path, { method, headers: method === 'GET' || method === 'HEAD' ? undefined : { 'Content-Type': body.trim().startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded' }, body: method === 'GET' || method === 'HEAD' ? undefined : body })
      const text = await res.text()
      const hdrs = ['x-signature', 'x-sig', 'x-auth', 'content-type'].map((h) => res.headers.get(h) ? `${h}: ${res.headers.get(h)}` : null).filter(Boolean).join('\n')
      setResult(`HTTP ${res.status}\n${hdrs}\n\n${text.slice(0, 4000)}`)
      onSent()
    } catch (e) { setResult(`요청 실패: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '6px 12px 10px', display: 'grid', gap: 6, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
      <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <select style={{ ...input, minWidth: 90 }} value={method} onChange={(e) => setMethod(e.target.value)}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select>
          <input style={{ ...input, flex: 1, fontFamily: 'var(--fl-font-mono)' }} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/hello?name=kim" onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); void send() } }} />
          <button style={primaryBtn} disabled={busy} onClick={() => { void send() }}>전송</button>
        </div>
        {method !== 'GET' && <textarea style={{ ...input, width: '100%', minHeight: 70, fontFamily: 'var(--fl-font-mono)', fontSize: 12, resize: 'vertical', boxSizing: 'border-box' }} value={body} onChange={(e) => setBody(e.target.value)} placeholder='요청 본문 — {"otp":"111111"} 또는 a=1&b=2' />}
      </div>
      <pre style={{ ...reqPre, maxHeight: 200, minHeight: 60, margin: 0 }}>{result ?? '응답이 여기에 표시됩니다.'}</pre>
    </div>
  )
}

// ---------- 스타일 ----------

const hdr: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)', flexWrap: 'wrap', flexShrink: 0 }
const leftNav: CSSProperties = { width: 268, flexShrink: 0, borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', padding: 10, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }
const navHead: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: 'var(--fl-text)', padding: '4px 6px 6px' }
const navItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '7px 8px', border: '1px solid transparent', borderRadius: 8, background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', textAlign: 'left', fontSize: 12.5 }
const navActive: CSSProperties = { background: 'var(--fl-surface-2)', borderColor: 'var(--fl-border)', boxShadow: 'inset 3px 0 0 var(--fl-primary)' }
const mchip: CSSProperties = { fontSize: 9.5, fontWeight: 800, fontFamily: 'var(--fl-font-mono)', minWidth: 40 }
const hitBadge: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const divider: CSSProperties = { height: 1, background: 'var(--fl-border)', margin: '6px 0' }
const rightPane: CSSProperties = { flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 18px 24px', background: 'var(--fl-bg)' }
const trafficWrap: CSSProperties = { flexShrink: 0, borderTop: '1px solid var(--fl-border)', background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', minHeight: 0, transition: 'height .15s' }
const trafficBar: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', borderBottom: '1px solid var(--fl-border)', minHeight: 36, flexWrap: 'wrap' }
const toolsMenu: CSSProperties = { position: 'absolute', top: 40, right: 120, width: 240, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 100, display: 'grid', gap: 2 }
const toolItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const tile: CSSProperties = { display: 'grid', gap: 4, textAlign: 'left', padding: 14, border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5 }
const kbd: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, padding: '1px 6px', border: '1px solid var(--fl-border)', borderRadius: 4, background: 'var(--fl-surface-2)', marginRight: 6 }
const lbl: CSSProperties = { fontSize: 12, fontWeight: 700, marginBottom: 6 }
const metaMono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const reqPre: CSSProperties = { margin: 0, padding: '6px 8px', fontSize: 11, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface-2)', borderRadius: 5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto' }
const panel: CSSProperties = { padding: 18, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const h2: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 6, lineHeight: 1.6 }
const code: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11, background: 'var(--fl-surface-2)', padding: '1px 5px', borderRadius: 4 }
const input: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13 }
const primaryBtn: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }
const ghostBtn: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const miniBtn: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12, cursor: 'pointer' }
const badge: CSSProperties = { padding: '3px 9px', borderRadius: 'var(--fl-radius-pill)', color: '#fff', fontSize: 11, fontWeight: 700 }
const legacyBanner: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', marginBottom: 12, border: '1px solid color-mix(in srgb, var(--fl-put, #f5a623) 60%, var(--fl-border))', background: 'color-mix(in srgb, var(--fl-put, #f5a623) 10%, var(--fl-surface))', borderRadius: 'var(--fl-radius-sm)', color: 'var(--fl-text)' }
