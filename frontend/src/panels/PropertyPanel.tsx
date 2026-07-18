import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { pluginsApi, runsApi, secretsApi, settingsApi, transformsApi } from '../api/client'
import { usePermissions } from '../auth/AuthContext'
import { toast } from '../components/toast'
import type { Binding, BodyType, GraphNode, HttpMethod, NodeField, NodeOutput, NodeVar, ReqMode, RespType, SingleNodeRunResult, TcpField, TcpRespField, WaitField as WaitFieldT } from '../api/types'
import { CopyIcon, DataInsertIcon } from '../components/icons'
import { BindingChip } from '../binding/BindingChip'
import { BindingPicker } from '../binding/BindingPicker'
import { TokenInput } from '../binding/TokenInput'
import { bindableSources } from '../binding/upstream'
import type { BindableSource } from '../binding/upstream'
import { asGraphNode } from '../canvas/graphAdapter'
import { ANNO_COLORS, catColor, METHOD_COLOR, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { fieldsToRaw, rawToFields, headersToRaw, rawToHeaders } from '../lib/bodyConvert'
import { parseCurl, toCurl } from '../lib/curl'
import { computeReachInfo, isUnreachableExecutable } from '../lib/reachable'
import { useEnvStore } from '../lib/environments'
import { useRunInput } from '../lib/runInput'
import { bindingToToken, isTokenizable } from '../lib/tokenGrammar'
import { newId } from '../lib/ids'
import { useEditorStore } from '../store/editorStore'
import { KeyValueEditor } from './KeyValueEditor'

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '10px 0 4px' }
const field: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, fontFamily: 'var(--fl-font-ui)' }
const mono: CSSProperties = { ...field, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }
const braceBtn: CSSProperties = { width: 32, height: 32, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
// wait(콜백 대기) 노드 — 콜백에 줄 응답 형식
const CALLBACK_RESP_TYPES = [
  { value: 'text', label: '문자열 (text/plain)' },
  { value: 'html', label: 'HTML (text/html)' },
  { value: 'json', label: 'JSON (application/json)' },
]
// 구조형 바디(키-값 또는 raw 텍스트 둘 다 가능) — jsonRaw 플래그로 [필드|Raw] 전환
const STRUCTURED_BODY: BodyType[] = ['json', 'urlencoded', 'form']
function rawBodyPlaceholder(bt: BodyType | undefined): string {
  if (bt === 'urlencoded' || bt === 'form') return 'a=1&b=2  또는 { } 로 데이터 삽입'
  if (bt === 'xml') return '<root> ... </root>  또는 { } 로 데이터 삽입'
  return '{ "key": "value" }  또는 { } 로 데이터 삽입'
}
// 'form' 은 'urlencoded' 와 백엔드 파싱이 동일 — 드롭다운에선 하나로 통합(중복 제거). 저장된 'form' 그래프는
// 선택값을 'urlencoded' 로 정규화해 표시하고(normRespType), 새로 고르면 'urlencoded' 로 저장(동작 불변).
const RESP_TYPES: RespType[] = ['json', 'xml', 'urlencoded', 'query', 'text', 'binary']
const normRespType = (rt: RespType | undefined): RespType => (rt === 'form' ? 'urlencoded' : rt ?? 'json')
const CHARSETS = ['UTF-8', 'EUC-KR', 'MS949', 'US-ASCII']
const OUTPUT_TYPES = ['string', 'int', 'number', 'boolean', 'object', 'array', 'secret']
// 단일 노드 독립 실행이 의미 있는 타입(즉석 처리). start/end/주석/대기·폼·입력은 제외.
const SINGLE_RUNNABLE = new Set(['http', 'set', 'if', 'switch', 'assert', 'transform', 'tcp'])

// 키형(json/xml/urlencoded/form/query): 응답이 키-값 구조라 "예상 응답 키"가 의미 있음 → 하위 노드가 키로 바인딩.
// 통짜형(text/binary): 키가 없으므로 응답 본문 전체가 단일 값(body)으로만 제공됨.
const KEYED_RESP: RespType[] = ['json', 'xml', 'urlencoded', 'form', 'query']
function respTypeLabel(rt: RespType): string {
  if (rt === 'query') return 'query (URL/쿼리 파라미터)'
  if (rt === 'urlencoded') return 'urlencoded / form (a=1&b=2)'
  return rt
}
function respOutputLabel(rt: RespType | undefined): string {
  if (rt === 'xml') return '응답 요소 (XML) — 하위 노드가 바인딩할 항목'
  if (rt === 'urlencoded' || rt === 'form') return '응답 필드 (urlencoded 키) — 하위 노드가 바인딩할 항목'
  if (rt === 'query') return '응답 필드 (쿼리 파라미터) — 하위 노드가 바인딩할 항목'
  return '예상 응답 필드 (JSON 키) — 하위 노드가 바인딩할 항목'
}

export function PropertyPanel({ width = 360, modal = false, onExpand, onCloseModal, onCollapse }: {
  width?: number; modal?: boolean; onExpand?: () => void; onCloseModal?: () => void; onCollapse?: () => void
}) {
  const selectedId = useEditorStore((s) => s.selectedId)
  const nodes = useEditorStore((s) => s.nodes)
  const edges = useEditorStore((s) => s.edges)
  const flowId = useEditorStore((s) => s.flowId)
  const update = useEditorStore((s) => s.updateNodeData)
  const selectNode = useEditorStore((s) => s.selectNode)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const duplicateSelection = useEditorStore((s) => s.duplicateSelection)
  const removeEdge = useEditorStore((s) => s.removeEdge)
  const [pick, setPick] = useState<string | null>(null) // rawBody | rawParams | rawHeaders (Raw 텍스트영역 전용)
  const [bodyConvNote, setBodyConvNote] = useState<string | null>(null) // 필드↔Raw 변환 안내
  const [single, setSingle] = useState<SingleNodeRunResult | null>(null) // 이 노드만 실행 결과
  const [singleRunning, setSingleRunning] = useState(false)
  const [advOpen, setAdvOpen] = useState(false) // HTTP 고급(문자셋) 접기
  const [curlText, setCurlText] = useState<string | null>(null) // cURL 붙여넣기 입력창(열림=문자열)
  const [secOverride, setSecOverride] = useState<Record<string, boolean>>({}) // HTTP 요청 섹션 접기 오버라이드
  const [previewOpen, setPreviewOpen] = useState(false) // 요청 미리보기 접기
  const focusNode = useEditorStore((s) => s.focusNode)
  const transforms = useQuery({ queryKey: ['transforms'], queryFn: transformsApi.list })
  const qc = useQueryClient()
  const { canPlatformAdmin, canEdit } = usePermissions()

  // 다른 노드 선택 시 단일 실행 결과 + HTTP 임시 UI 상태 초기화(다른 노드로 새어가지 않게)
  useEffect(() => {
    setSingle(null); setSingleRunning(false)
    setCurlText(null); setSecOverride({}); setPreviewOpen(false); setAdvOpen(false)
  }, [selectedId])

  // 이 노드만 실행 — 새 컨텍스트로 즉석 실행(상류 바인딩 null). 대기/폼/입력/client 는 백엔드가 거절.
  const runSingle = async () => {
    if (!flowId || !selectedId) return
    setSingleRunning(true)
    try { setSingle(await runsApi.runNode(flowId, selectedId)) }
    catch (e) { setSingle({ ok: false, httpStatus: null, output: null, requestText: null, responseText: e instanceof Error ? e.message : String(e) }) }
    finally { setSingleRunning(false) }
  }

  const node = useMemo<GraphNode | null>(() => {
    const n = nodes.find((x) => x.id === selectedId)
    return n ? asGraphNode(n.data) : null
  }, [nodes, selectedId])

  // 조상 소스 + 그래프 내 wait 노드 수신 URL(앞 노드에서 returnUrl/notiUrl 에 꽂는 표준 패턴)
  // envStore 를 구독해 활성 환경 변수 변경(스위처/관리 다이얼로그)이 즉시 바인딩 피커에 반영되게 한다.
  const envStore = useEnvStore()
  const runInput = useRunInput()
  // 시크릿 이름을 바인딩 소스로 노출({{ 이름@secret }}) — 값은 서버에만(write-only).
  // 활성 환경에서 적용될 것만 보여준다: 공통 + 활성 환경(백엔드 activeSecrets 오버레이 규칙과 동일, 이름으로 dedupe).
  const secretsQ = useQuery({ queryKey: ['secrets'], queryFn: secretsApi.list })
  const secretNames = useMemo(() => {
    const active = envStore.active
    const seen = new Set<string>()
    for (const s of secretsQ.data ?? []) {
      const common = !s.environment
      if (common || s.environment === active) seen.add(s.name)
    }
    return Array.from(seen)
  }, [secretsQ.data, envStore.active])
  // env/input 을 시그니처로 참조 — bindableSources 가 activeEnvVars/activeInputVars 를 명령형으로 읽으므로,
  // 변경 시 재계산되도록 memo 입력에 포함(린트가 '미사용'으로 오인하지 않게 실제 값으로 참조).
  const envSig = JSON.stringify(envStore.active ? envStore.envs[envStore.active] ?? {} : {}) + '|' + JSON.stringify(runInput) + '|' + secretNames.join(',')
  const sources: BindableSource[] = useMemo(
    () => {
      void envSig
      const base = selectedId ? bindableSources(nodes, edges, selectedId) : []
      if (secretNames.length) base.unshift({ id: 'secret', name: '시크릿', type: 'secret', items: secretNames.map((k) => ({ key: k, type: '시크릿', scope: null, group: 'response' as const })) })
      return base
    },
    // envSig 가 env/input/secret 시그니처를 모두 담아 재계산을 구동 — secretNames 는 그 안에 포함됨
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges, selectedId, envSig],
  )

  // 연결(바로가기) — 선택 노드의 상류(들어오는)·하류(나가는) 이웃 노드 id (early-return 위에서 훅 순서 고정)
  const upstreamIds = useMemo(() => (selectedId ? edges.filter((e) => e.target === selectedId).map((e) => e.source) : []), [edges, selectedId])
  const downstreamIds = useMemo(() => (selectedId ? edges.filter((e) => e.source === selectedId).map((e) => e.target) : []), [edges, selectedId])
  // 실행 도달성 — START 에서 못 오는 노드는 실행 시 건너뜀. 실행 전에 미리 경고.
  const reachInfo = useMemo(() => computeReachInfo(nodes, edges), [nodes, edges])

  // 다른 노드를 고르면 변환 안내는 초기화
  useEffect(() => setBodyConvNote(null), [selectedId])

  if (!node) {
    return (
      <aside aria-label="속성" style={{ ...shell, width }}>
        <div style={{ padding: '18px 16px', display: 'grid', gap: 14 }}>
          <p style={{ color: 'var(--fl-text)', fontSize: 13.5, fontWeight: 600, margin: 0 }}>노드를 클릭하면 여기서 설정합니다.</p>
          <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 7, color: 'var(--fl-text-muted)', fontSize: 12.5, lineHeight: 1.5 }}>
            <li>왼쪽 팔레트에서 노드를 캔버스로 끌어다 놓으세요.</li>
            <li>노드의 핸들(●)을 드래그해 다음 노드와 연결하세요.</li>
            <li>노드를 클릭하면 이 패널에서 편집합니다.</li>
          </ol>
          <p style={{ margin: 0, color: 'var(--fl-text-muted)', fontSize: 12 }}>선택한 노드는 <kbd style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11, padding: '1px 5px', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 4 }}>Delete</kbd> 로 삭제합니다.</p>
        </div>
      </aside>
    )
  }

  const id = node.id
  const rfNode = nodes.find((n) => n.id === id)
  const unreachable = rfNode ? isUnreachableExecutable(rfNode, reachInfo) : false
  const fields = node.fields ?? { params: [], headers: [], body: [] }
  const setRows = (t: 'params' | 'headers' | 'body', rows: NodeField[]) => update(id, { fields: { ...fields, [t]: rows } })
  const setInputField = (key: string, patch: Partial<NodeField>) => {
    const body = node.fields?.body ?? []
    const nextBody = body.some((f) => f.key === key)
      ? body.map((f) => (f.key === key ? { ...f, ...patch } : f))
      : [...body, { id: newId(), key, value: '', ...patch }]
    update(id, { fields: { params: fields.params ?? [], headers: fields.headers ?? [], body: nextBody } })
  }
  const sourceType = (b: Binding) => sources.find((s) => s.id === b.sourceId)?.type
  const selectedTransform = (transforms.data ?? []).find((t) => t.id === node.transformId)

  const nodeLabel = (nid: string): { name: string; type: string } => {
    const n = nodes.find((x) => x.id === nid)
    const d = n ? asGraphNode(n.data) : null
    return { name: d?.name || (d ? typeLabel(d.type) : nid), type: d?.type ?? '' }
  }
  const copyText = (t: string, msg: string) => { void navigator.clipboard?.writeText(t).then(() => toast(msg, 'ok')).catch(() => {}) }

  // URL = Base URL + Path 병합(백엔드는 base+path 이므로 전체를 baseUrl 로 쓰고 path 는 비운다 — 무변경 호환)
  const mergedUrl = (node.baseUrlBound ? bindingToToken(node.baseUrlBound) : (node.baseUrl ?? '')) + (node.path ?? '')
  const setMergedUrl = (v: string) => update(id, { baseUrl: v, path: '', baseUrlBound: null })

  // URL 의 ?쿼리 → Params 필드로 분리(스마트)
  const urlQuery = (() => {
    const qi = mergedUrl.indexOf('?')
    return qi >= 0 ? mergedUrl.slice(qi + 1) : ''
  })()
  const extractQueryToParams = () => {
    const qi = mergedUrl.indexOf('?')
    if (qi < 0) return
    const base = mergedUrl.slice(0, qi)
    const qs = mergedUrl.slice(qi + 1)
    const rows: NodeField[] = qs.split('&').filter(Boolean).map((pair) => {
      const eq = pair.indexOf('=')
      const k = eq >= 0 ? pair.slice(0, eq) : pair
      const val = eq >= 0 ? pair.slice(eq + 1) : ''
      return { id: newId(), key: decodeURIComponent(k), value: decodeURIComponent(val.replace(/\+/g, ' ')) }
    })
    update(id, { baseUrl: base, path: '', baseUrlBound: null, paramsRaw: false, fields: { params: [...(fields.params ?? []), ...rows], headers: fields.headers ?? [], body: fields.body ?? [] } })
    setSecOverride((p) => ({ ...p, query: true }))
    toast(`쿼리 ${rows.length}개를 Params 로 분리했습니다.`, 'ok')
  }

  // 현재 헤더를 key/value 목록으로(필드 또는 Raw 모드 공통) — cURL 복사용
  const headerList = (): { key: string; value: string }[] => {
    if (node.headersRaw) {
      return (node.rawHeaders ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const ci = l.indexOf(':')
        return ci > 0 ? { key: l.slice(0, ci).trim(), value: l.slice(ci + 1).trim() } : { key: l, value: '' }
      }).filter((h) => h.key)
    }
    return (fields.headers ?? []).filter((f) => f.key?.trim()).map((f) => ({ key: f.key!, value: f.bound ? bindingToToken(f.bound) : (f.value ?? '') }))
  }
  const currentBody = (): string => {
    if (node.bodyType === 'raw' || node.bodyType === 'xml' || node.jsonRaw) return node.rawBody ?? ''
    const rows = fields.body ?? []
    if (!rows.length) return ''
    if ((node.bodyType ?? 'json') === 'json') return `{${rows.filter((r) => r.key).map((r) => `"${r.key}":${JSON.stringify(r.bound ? bindingToToken(r.bound) : (r.value ?? ''))}`).join(',')}}`
    return rows.filter((r) => r.key).map((r) => `${r.key}=${r.bound ? bindingToToken(r.bound) : (r.value ?? '')}`).join('&')
  }
  const copyCurl = () => copyText(toCurl({ method: node.method ?? 'GET', url: mergedUrl, headers: headerList(), body: currentBody() }), 'cURL 로 복사했습니다.')
  const applyCurl = (text: string) => {
    const r = parseCurl(text)
    if (!r) { toast('cURL 을 인식하지 못했습니다. `curl ...` 형식인지 확인하세요.', 'error'); return }
    const patch: Partial<GraphNode> = {
      method: r.method as HttpMethod, baseUrl: r.url, path: '', baseUrlBound: null,
      headersRaw: false,
      fields: { params: fields.params ?? [], headers: r.headers.map((h) => ({ id: newId(), key: h.key, value: h.value })), body: fields.body ?? [] },
    }
    if (r.body) { patch.bodyType = r.bodyType === 'json' ? 'json' : r.bodyType === 'urlencoded' ? 'urlencoded' : 'raw'; patch.jsonRaw = true; patch.rawBody = r.body; setSecOverride((p) => ({ ...p, body: true })) }
    update(id, patch)
    setCurlText(null)
    toast('cURL 을 노드에 반영했습니다.', 'ok')
  }

  // --- HTTP: 요청 3파트 통합(섹션) + 프리셋 + Content-Type 미리보기 ---
  const method = node.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const bodyKind: BodyType = node.bodyType === 'form' ? 'urlencoded' : (node.bodyType ?? 'json') // form==urlencoded (백엔드 동일 처리)
  const paramCount = node.paramsRaw ? ((node.rawParams ?? '').trim() ? 1 : 0) : (fields.params ?? []).filter((f) => f.key?.trim()).length
  const headerCount = node.headersRaw ? ((node.rawHeaders ?? '').trim() ? 1 : 0) : (fields.headers ?? []).filter((f) => f.key?.trim()).length
  const bodyFilled = (bodyKind === 'raw' || bodyKind === 'xml' || node.jsonRaw) ? !!(node.rawBody?.trim()) : (fields.body ?? []).some((f) => f.key?.trim())
  // 사용자가 명시한 Content-Type 헤더가 있으면 그걸 우선, 아니면 bodyType 로 백엔드가 붙이는 값 미러
  const explicitCT = node.headersRaw
    ? ((node.rawHeaders ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => /^content-type\s*:/i.test(l))?.split(':').slice(1).join(':').trim())
    : (fields.headers ?? []).find((f) => (f.key ?? '').toLowerCase() === 'content-type')?.value
  const autoCT = bodyKind === 'json' ? 'application/json' : bodyKind === 'urlencoded' ? 'application/x-www-form-urlencoded' : bodyKind === 'xml' ? 'application/xml' : ''
  const cs = node.charset ?? 'UTF-8'
  const wireCs = cs === 'MS949' ? 'windows-949' : cs // 백엔드 wireCharset 와 동일(MS949→windows-949, 그 외 cs.name() 대문자 유지)
  // 백엔드는 explicit·auto 여부와 무관하게 (본문有 · 서버모드 · 비UTF-8 · charset 미포함) 이면 CT 에 charset 부착
  const ctBase = hasBody ? (explicitCT || autoCT) : ''
  const contentType = ctBase && node.reqMode !== 'client' && cs !== 'UTF-8' && !/charset/i.test(ctBase)
    ? `${ctBase}; charset=${wireCs}`
    : ctBase

  // 프리셋: 흔한 조합을 한 번에(method+bodyType). 현재 선택 하이라이트는 파생.
  const presetKey = method === 'GET' ? 'get' : (hasBody && bodyKind === 'json') ? 'json' : (hasBody && bodyKind === 'urlencoded') ? 'form' : (hasBody && bodyKind === 'raw') ? 'raw' : 'other'
  const applyPreset = (k: string) => {
    if (k === 'get') { update(id, { method: 'GET' as HttpMethod }); return }
    if (!hasBody) update(id, { method: 'POST' as HttpMethod }) // GET/HEAD → POST 로 승격해 본문이 실제로 실리게
    // 본문 종류 전환은 changeBodyType 로 — 내용 변환/정규화(보이는 것=보내는 것) 유지
    if (k === 'json') changeBodyType('json')
    else if (k === 'form') changeBodyType('urlencoded')
    else if (k === 'raw') changeBodyType('raw')
  }

  // 섹션 접기 상태(사용자 오버라이드 우선, 없으면 스마트 기본값)
  const secDefault = (key: string): boolean =>
    key === 'query' ? (paramCount > 0 || method === 'GET')
    : key === 'headers' ? headerCount > 0
    : key === 'body' ? true
    : key === 'resp' ? false
    : false
  const secIsOpen = (key: string): boolean => secOverride[key] ?? secDefault(key)
  const toggleSec = (key: string) => setSecOverride((p) => ({ ...p, [key]: !secIsOpen(key) }))

  // 단일 실행 응답에서 출력 키 자동 채우기
  const inferOut = (v: unknown): string => v === null ? 'string' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'object' ? 'object' : 'string'
  const populateOutputs = () => {
    const out = single?.output
    if (!out || typeof out !== 'object' || Array.isArray(out)) return
    const existing = new Set((node.outputs ?? []).map((o) => o.key))
    const added = Object.entries(out as Record<string, unknown>).filter(([k]) => k && !existing.has(k)).map(([k, v]) => ({ key: k, type: inferOut(v) }))
    if (!added.length) { toast('추가할 새 키가 없습니다.', 'ok'); return }
    update(id, { outputs: [...(node.outputs ?? []), ...added] })
    toast(`응답에서 출력 키 ${added.length}개를 추가했습니다.`, 'ok')
  }

  // 요청 미리보기 — 보이는 것 = 보내는 것 (쿼리는 URL 에 붙이고, 백엔드가 자동 붙이는 Content-Type 도 포함)
  const previewUrl = (() => {
    if (node.paramsRaw) {
      const raw = (node.rawParams ?? '').trim()
      return raw ? mergedUrl + (mergedUrl.includes('?') ? '&' : '?') + raw : mergedUrl
    }
    if (paramCount === 0) return mergedUrl
    const qs = (fields.params ?? []).filter((f) => f.key?.trim()).map((f) => `${f.key}=${f.bound ? bindingToToken(f.bound) : (f.value ?? '')}`).join('&')
    return mergedUrl + (mergedUrl.includes('?') ? '&' : '?') + qs
  })()
  const previewHeaders = (() => {
    const hs = headerList().map((h) => ({ ...h }))
    if (hasBody && contentType) {
      const i = hs.findIndex((h) => h.key.toLowerCase() === 'content-type')
      if (i < 0) hs.push({ key: 'Content-Type', value: contentType }) // 백엔드 putIfAbsent 자동 부착 미러
      else if (node.reqMode !== 'client' && cs !== 'UTF-8' && !/charset/i.test(hs[i].value)) hs[i].value = `${hs[i].value}; charset=${wireCs}`
    }
    return hs
  })()
  const previewText = `${method} ${previewUrl}\n${previewHeaders.map((h) => `${h.key}: ${h.value}`).join('\n')}${hasBody && currentBody() ? '\n\n' + currentBody() : ''}`

  // [필드 ↔ Raw] 전환 시 현재 내용을 서로 변환(치환). 바인딩은 토큰으로, id 는 새로 부여.
  const switchBodyMode = (raw: boolean) => {
    if (raw === !!node.jsonRaw) return // 이미 그 모드
    const bt = node.bodyType ?? 'json'
    if (raw) {
      // 필드 → Raw: 키-값(바인딩은 토큰, 타입 보존)을 본문 텍스트로 직렬화
      const bodyFields = node.fields?.body ?? []
      const rows = bodyFields.map((f) => ({ key: f.key ?? '', value: f.bound ? bindingToToken(f.bound) : (f.value ?? ''), type: f.type }))
      // json 에서 바인딩 값은 따옴표 문자열 토큰으로 직렬화됨 → 숫자/불리언이면 문자열이 됨(안내)
      setBodyConvNote(bt === 'json' && bodyFields.some((f) => f.bound)
        ? '바인딩 필드는 Raw(JSON)에서 따옴표 문자열로 직렬화됩니다(숫자/불리언이면 문자열). 필요하면 Raw 에서 따옴표를 직접 제거하세요.'
        : null)
      update(id, { jsonRaw: true, rawBody: fieldsToRaw(rows, bt) })
    } else {
      // Raw → 필드: 본문 텍스트를 키-값으로 파싱(실패 시 원문 보존 + 안내)
      const parsed = rawToFields(node.rawBody ?? '', bt)
      if (parsed === null) {
        setBodyConvNote('Raw 본문을 필드로 변환하지 못했어요(유효한 JSON/형식 확인). 원문은 Raw 에 그대로 있습니다.')
        update(id, { jsonRaw: false })
      } else {
        setBodyConvNote(null)
        const body: NodeField[] = parsed.map((kv) => ({ id: newId(), key: kv.key, value: kv.value, type: kv.type }))
        update(id, { jsonRaw: false, fields: { params: fields.params ?? [], headers: fields.headers ?? [], body } })
      }
    }
  }

  // Params(쿼리, urlencoded)·Headers(Key: Value)의 [필드 ↔ Raw] 전환. body 와 동일하게 내용을 실제 변환한다.
  const switchKvRaw = (t: 'params' | 'headers', raw: boolean) => {
    const cur = t === 'params' ? !!node.paramsRaw : !!node.headersRaw
    if (raw === cur) return
    setBodyConvNote(null)
    const rows = (node.fields?.[t] ?? []).map((f) => ({ key: f.key ?? '', value: f.bound ? bindingToToken(f.bound) : (f.value ?? '') }))
    if (raw) {
      const text = t === 'params' ? fieldsToRaw(rows, 'urlencoded') : headersToRaw(rows)
      update(id, t === 'params' ? { paramsRaw: true, rawParams: text } : { headersRaw: true, rawHeaders: text })
    } else {
      const rawText = t === 'params' ? (node.rawParams ?? '') : (node.rawHeaders ?? '')
      const parsed = t === 'params' ? rawToFields(rawText, 'urlencoded') : rawToHeaders(rawText)
      if (parsed === null) {
        setBodyConvNote(t === 'headers'
          ? 'Raw 헤더를 필드로 변환하지 못했어요(각 줄이 "이름: 값" 형식인지 확인). 원문은 Raw 에 그대로 있습니다.'
          : 'Raw 를 필드로 변환하지 못했어요. 원문은 Raw 에 그대로 있습니다.')
        update(id, t === 'params' ? { paramsRaw: false } : { headersRaw: false })
      } else {
        const next: NodeField[] = parsed.map((kv) => ({ id: newId(), key: kv.key, value: kv.value }))
        update(id, t === 'params'
          ? { paramsRaw: false, fields: { ...fields, params: next } }
          : { headersRaw: false, fields: { ...fields, headers: next } })
      }
    }
  }

  // 폼 전송(WAIT) 폼 데이터의 [필드 ↔ Raw] 전환(urlencoded). body 처럼 jsonRaw/rawBody 슬롯을 재사용.
  const switchFormRaw = (raw: boolean) => {
    if (raw === !!node.jsonRaw) return
    setBodyConvNote(null)
    if (raw) {
      const rows = (node.fields?.body ?? []).map((f) => ({ key: f.key ?? '', value: f.bound ? bindingToToken(f.bound) : (f.value ?? '') }))
      update(id, { jsonRaw: true, rawBody: fieldsToRaw(rows, 'urlencoded') })
    } else {
      const parsed = rawToFields(node.rawBody ?? '', 'urlencoded')
      const body: NodeField[] = (parsed ?? []).map((kv) => ({ id: newId(), key: kv.key, value: kv.value }))
      update(id, { jsonRaw: false, fields: { params: fields.params ?? [], headers: fields.headers ?? [], body } })
    }
  }

  // bodyType 변경 시 모드/내용을 정규화·변환해 "보이는 것과 보내는 것"이 항상 일치하게 한다.
  const changeBodyType = (next: BodyType) => {
    setBodyConvNote(null)
    const old = node.bodyType ?? 'json'
    if (next === old) {
      update(id, { bodyType: next })
      return
    }
    const oldStruct = STRUCTURED_BODY.includes(old)
    const nextStruct = STRUCTURED_BODY.includes(next)
    if (oldStruct && nextStruct) {
      // 구조형↔구조형: 필드는 공용이라 그대로. Raw 모드면 rawBody 를 새 포맷으로 변환.
      if (node.jsonRaw) {
        const kvs = rawToFields(node.rawBody ?? '', old)
        update(id, { bodyType: next, rawBody: kvs ? fieldsToRaw(kvs, next) : (node.rawBody ?? '') })
      } else {
        update(id, { bodyType: next })
      }
    } else if (oldStruct && !nextStruct) {
      // 구조형 → raw/xml(텍스트 전용): 현재 내용을 텍스트로 보이게 + jsonRaw 정리
      let raw = node.rawBody ?? ''
      if (!node.jsonRaw) {
        const kvs = (node.fields?.body ?? []).map((f) => ({ key: f.key ?? '', value: f.bound ? bindingToToken(f.bound) : (f.value ?? ''), type: f.type }))
        raw = fieldsToRaw(kvs, old)
      }
      update(id, { bodyType: next, rawBody: raw, jsonRaw: false })
    } else if (!oldStruct && nextStruct) {
      // raw/xml → 구조형: rawBody 파싱 시도(실패하면 Raw 모드 유지해 원문 보존)
      const kvs = rawToFields(node.rawBody ?? '', next)
      if (kvs) {
        const body: NodeField[] = kvs.map((kv) => ({ id: newId(), key: kv.key, value: kv.value, type: kv.type }))
        update(id, { bodyType: next, jsonRaw: false, fields: { params: fields.params ?? [], headers: fields.headers ?? [], body } })
      } else {
        update(id, { bodyType: next, jsonRaw: true })
      }
    } else {
      update(id, { bodyType: next }) // raw ↔ xml (둘 다 텍스트)
    }
  }

  // Raw 텍스트영역(rawBody/rawParams/rawHeaders)용 삽입 — 한 줄 입력은 TokenInput 이 인라인 칩으로 처리한다.
  const onPick = (b: Binding) => {
    if (pick === 'rawBody') update(id, { rawBody: `${node.rawBody ?? ''} ${bindingToToken(b)}`.trim() })
    else if (pick === 'rawParams') update(id, { rawParams: `${node.rawParams ?? ''} ${bindingToToken(b)}`.trim() })
    else if (pick === 'rawHeaders') update(id, { rawHeaders: `${node.rawHeaders ?? ''} ${bindingToToken(b)}`.trim() })
    else if (pick === 'waitMsg') update(id, { waitMsg: `${node.waitMsg ?? ''} ${bindingToToken(b)}`.trim() })
    else if (pick === 'callbackRespBody') update(id, { callbackRespBody: `${node.callbackRespBody ?? ''} ${bindingToToken(b)}`.trim() })
    setPick(null)
  }

  return (
    <aside aria-label="속성" style={{ ...shell, width }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden style={{ color: catColor(node.cat), fontSize: 16 }}>{typeIcon(node.type)}</span>
        <input aria-label="노드 이름" value={node.name ?? ''} placeholder={typeLabel(node.type)} onChange={(e) => update(id, { name: e.target.value })} style={{ ...field, fontWeight: 600, fontFamily: 'var(--fl-font-head)' }} />
        {onExpand && (
          <button onClick={onExpand} aria-label="넓게 편집" title="넓은 모달로 편집" style={iconBtn}>⤢</button>
        )}
        {onCollapse && (
          <button onClick={onCollapse} aria-label="속성 패널 접기" title="접기" style={iconBtn}>»</button>
        )}
        {modal
          ? <button onClick={onCloseModal} aria-label="모달 닫기" title="닫기(도킹으로)" style={closeBtn}>×</button>
          : <button onClick={() => selectNode(null)} aria-label="패널 닫기" style={closeBtn}>×</button>}
      </header>

      <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
        <button
          onClick={() => copyText(id, '노드 id 를 복사했습니다.')}
          title="노드 id 복사"
          style={{ border: 'none', background: 'transparent', padding: 0, fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', cursor: 'pointer' }}
        >{typeLabel(node.type)} · #{id} ⧉</button>

        {(upstreamIds.length > 0 || downstreamIds.length > 0) && (
          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            {upstreamIds.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', minWidth: 42 }}>← 이전</span>
                {upstreamIds.map((nid) => { const nl = nodeLabel(nid); return (
                  <button key={'u' + nid} style={navChip} title={`${nl.name} 로 이동`} onClick={() => focusNode(nid)}>
                    <span aria-hidden style={{ color: catColor(nl.type), flexShrink: 0 }}>{typeIcon(nl.type)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nl.name}</span>
                  </button>
                ) })}
              </div>
            )}
            {downstreamIds.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', minWidth: 42 }}>다음 →</span>
                {downstreamIds.map((nid) => { const nl = nodeLabel(nid); return (
                  <button key={'d' + nid} style={navChip} title={`${nl.name} 로 이동`} onClick={() => focusNode(nid)}>
                    <span aria-hidden style={{ color: catColor(nl.type), flexShrink: 0 }}>{typeIcon(nl.type)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nl.name}</span>
                  </button>
                ) })}
              </div>
            )}
          </div>
        )}

        {unreachable && (
          <div style={{ marginTop: 10, padding: '8px 10px', border: '1px solid var(--fl-put)', borderRadius: 'var(--fl-radius-sm)', background: 'color-mix(in srgb, var(--fl-put) 12%, transparent)', fontSize: 12, color: 'var(--fl-text)', lineHeight: 1.5 }}>
            ⚠ <b>시작(START)에 연결되어 있지 않습니다.</b> 이 노드는 실행 시 <b>건너뜁니다</b> — 위쪽 노드에서 핸들(●)을 끌어 연결하세요.
          </div>
        )}

        {SINGLE_RUNNABLE.has(node.type) && canEdit && (
          <div style={{ marginTop: 10 }}>
            <button onClick={runSingle} disabled={singleRunning} style={singleBtn}
              title="이 노드만 새 컨텍스트로 즉석 실행합니다(상류 바인딩은 값이 없어 빈 값). 전체 실행과 별개.">
              {singleRunning ? '실행 중…' : '▶ 이 노드만 실행'}
            </button>
            {single && (
              <div style={{ marginTop: 8, border: `1px solid ${single.ok ? 'var(--fl-ok)' : 'var(--fl-fail)'}`, borderRadius: 'var(--fl-radius-sm)', overflow: 'hidden' }}>
                <div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600, background: 'var(--fl-surface-2)', color: single.ok ? 'var(--fl-ok)' : 'var(--fl-fail)' }}>
                  {single.ok ? '✓ 성공' : '✕ 실패'}{single.httpStatus != null ? ` · HTTP ${single.httpStatus}` : ''}
                </div>
                {single.output != null && (
                  <pre style={singlePre}>{typeof single.output === 'string' ? single.output : JSON.stringify(single.output, null, 2)}</pre>
                )}
                {single.responseText && (!single.ok || single.output == null) && (
                  <pre style={{ ...singlePre, color: single.ok ? 'var(--fl-text)' : 'var(--fl-fail)' }}>{single.responseText}</pre>
                )}
              </div>
            )}
          </div>
        )}

        {(node.type === 'note' || node.type === 'group') && (
          <>
            {node.type === 'note' ? (
              <>
                <label style={label}>메모 내용</label>
                <textarea
                  aria-label="메모 내용"
                  style={{ ...field, minHeight: 110, resize: 'vertical', lineHeight: 1.5 }}
                  value={node.noteText ?? ''}
                  onChange={(e) => update(id, { noteText: e.target.value })}
                  placeholder="메모를 입력하세요… (캔버스의 노드 안에서도 바로 입력됩니다)"
                />
              </>
            ) : (
              <>
                <label style={label}>크기 (px · 그리드 22 배수로 스냅)</label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    aria-label="영역 폭"
                    type="number"
                    step={22}
                    min={110}
                    style={{ ...field, width: 100 }}
                    value={node.groupW ?? 396}
                    onChange={(e) => update(id, { groupW: Math.max(110, Math.round((Number(e.target.value) || 396) / 22) * 22) })}
                  />
                  <span style={{ color: 'var(--fl-text-muted)', fontSize: 12 }}>×</span>
                  <input
                    aria-label="영역 높이"
                    type="number"
                    step={22}
                    min={66}
                    style={{ ...field, width: 100 }}
                    value={node.groupH ?? 264}
                    onChange={(e) => update(id, { groupH: Math.max(66, Math.round((Number(e.target.value) || 264) / 22) * 22) })}
                  />
                </div>
              </>
            )}

            <label style={label}>색</label>
            <div role="group" aria-label="주석 색" style={{ display: 'flex', gap: 8 }}>
              {Object.entries(ANNO_COLORS).map(([key, c]) => {
                const active = (node.noteColor ?? (node.type === 'group' ? 'gray' : 'yellow')) === key
                return (
                  <button
                    key={key}
                    type="button"
                    title={c.label}
                    aria-label={`색: ${c.label}`}
                    aria-pressed={active}
                    onClick={() => update(id, { noteColor: key })}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: c.bg,
                      border: active ? `2px solid ${c.border}` : '1px solid var(--fl-border)',
                      boxShadow: active ? '0 0 0 2px var(--fl-surface), 0 0 0 3.5px ' + c.border : 'none',
                    }}
                  />
                )
              })}
            </div>

            <p style={hintP}>
              {node.type === 'note'
                ? '메모는 캔버스 주석입니다 — 연결·실행과 무관하고, 실행 시 건너뜁니다.'
                : '영역 박스는 노드들 뒤에 깔리는 표시용 사각형입니다 — 제목바를 드래그해 옮기고, 우하단 모서리로 크기를 조절합니다. 실행과 무관합니다.'}
            </p>
          </>
        )}

        {node.type === 'switch' && (() => {
          const ports = node.switchPorts?.length ? node.switchPorts : [{ id: '1', label: '1' }, { id: '2', label: '2' }]
          const active = node.switchActive ?? ports[0].id
          const removePort = (pid: string) => {
            const next = ports.filter((p) => p.id !== pid)
            // 그 트랙에서 나가던 엣지도 함께 제거(활성화될 수 없는 유령 선로 방지)
            for (const e of edges) if (e.source === id && (e.sourceHandle ?? 'out') === pid) removeEdge(e.id)
            update(id, { switchPorts: next, switchActive: active === pid ? next[0]?.id : active })
          }
          const addPort = () => {
            let n2 = ports.length + 1
            while (ports.some((p) => p.id === String(n2))) n2++
            update(id, { switchPorts: [...ports, { id: String(n2), label: String(n2) }] })
          }
          return (
            <>
              <label style={label}>트랙 (선로) — 실행은 젖혀둔 트랙으로만 흐릅니다</label>
              <div style={{ display: 'grid', gap: 6 }}>
                {ports.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="radio"
                      name={`sw-active-${id}`}
                      aria-label={`트랙 ${p.label || p.id} 로 전환`}
                      checked={active === p.id}
                      onChange={() => update(id, { switchActive: p.id })}
                      style={{ accentColor: 'var(--fl-put)', cursor: 'pointer' }}
                    />
                    <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11, color: 'var(--fl-text-muted)', width: 16, textAlign: 'center' }}>{p.id}</span>
                    <input
                      aria-label={`트랙 ${p.id} 이름`}
                      style={{ ...field, flex: 1 }}
                      value={p.label ?? ''}
                      placeholder={`트랙 ${p.id}`}
                      onChange={(e) => update(id, { switchPorts: ports.map((x) => (x.id === p.id ? { ...x, label: e.target.value } : x)) })}
                    />
                    <button
                      onClick={() => removePort(p.id)}
                      disabled={ports.length <= 2}
                      aria-label={`트랙 ${p.label || p.id} 삭제`}
                      title={ports.length <= 2 ? '트랙은 최소 2개' : '트랙 삭제(연결도 제거)'}
                      style={{ ...braceBtn, color: ports.length <= 2 ? 'var(--fl-text-muted)' : 'var(--fl-fail)', cursor: ports.length <= 2 ? 'not-allowed' : 'pointer' }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              {ports.length < 6 && (
                <button onClick={addPort} style={{ ...addDashed, marginTop: 8, width: '100%' }}>+ 트랙 추가</button>
              )}
              <p style={hintP}>
                열차 선로 전환기처럼 <b>젖혀둔 트랙 하나로만</b> 실행이 흐르고, 나머지 트랙의 하류는 건너뜁니다(조건 평가 없음).
                캔버스에서 노드의 트랙을 클릭해도 전환됩니다 — 테스트 중 mock 경로 ↔ 실제 경로 전환 같은 용도.
              </p>
            </>
          )
        })()}

        {node.type === 'http' && (
          <>
            {/* URL 한 줄 — [메서드▾][주소]. Base URL·Path 는 하나로 합쳤다(안에서 https://.../{{ id }}/ 처럼 토큰으로). */}
            <label style={label}>URL (메서드 · 주소)</label>
            {node.baseUrlBound && !isTokenizable(node.baseUrlBound) ? (
              // 토큰 문법 밖 키/id 의 구(舊) bound — 이관하면 조용히 깨지므로 구조적 바인딩 칩 + Path 유지
              <>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <select aria-label="메서드" style={methodSel(node.method)} value={node.method ?? 'GET'} onChange={(e) => update(id, { method: e.target.value as HttpMethod })}>
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <div style={{ flex: 1, minWidth: 0 }}><BindingChip binding={node.baseUrlBound} sourceType={sourceType(node.baseUrlBound)} onRemove={() => update(id, { baseUrlBound: null })} /></div>
                </div>
                <TokenInput ariaLabel="Path" value={node.path ?? ''} onChange={(v) => update(id, { path: v })} sources={sources} placeholder="/resource — { } 로 데이터 삽입" />
              </>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <select aria-label="메서드" style={methodSel(node.method)} value={node.method ?? 'GET'} onChange={(e) => update(id, { method: e.target.value as HttpMethod })}>
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TokenInput
                    ariaLabel="URL"
                    value={mergedUrl}
                    onChange={setMergedUrl}
                    sources={sources}
                    placeholder="https://api.example.com/{{ id }}/detail — { } 로 데이터 삽입"
                  />
                </div>
              </div>
            )}

            {!mergedUrl.trim() && !node.baseUrlBound && (
              <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 6 }}>⚠ URL 이 비어 있습니다 — 호출할 주소를 입력하세요.</p>
            )}
            {urlQuery && (
              <button onClick={extractQueryToParams} style={smartLink} title="URL 의 ? 뒤 쿼리를 Params 필드로 옮깁니다">
                ↳ 쿼리 {urlQuery.split('&').filter(Boolean).length}개를 Params 로 분리
              </button>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={() => setCurlText(curlText === null ? '' : null)} style={ghostMini} title="curl 명령을 붙여넣어 이 노드를 채웁니다">cURL 붙여넣기</button>
              <button onClick={copyCurl} style={ghostMini} title="이 노드를 curl 명령으로 클립보드에 복사(토큰은 그대로)">cURL 로 복사</button>
            </div>
            {curlText !== null && (
              <div style={{ marginTop: 6 }}>
                <textarea autoFocus style={{ ...mono, minHeight: 74, resize: 'vertical' }} value={curlText} onChange={(e) => setCurlText(e.target.value)}
                  placeholder="curl -X POST 'https://api.example.com/pay' -H 'Authorization: Bearer ...' --data '{&quot;amount&quot;:1000}'" />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <button onClick={() => applyCurl(curlText)} style={{ ...braceBtn, width: 'auto', padding: '0 14px', color: 'var(--fl-primary)', fontWeight: 600 }}>적용</button>
                  <button onClick={() => setCurlText(null)} style={ghostMini}>취소</button>
                </div>
              </div>
            )}

            <button onClick={() => setAdvOpen((v) => !v)} style={advToggle} aria-expanded={advOpen}>
              {advOpen ? '▾' : '▸'} 고급 — 문자셋 · 요청 방식(서버/클라이언트)
            </button>
            {advOpen && (
              <div style={{ borderLeft: '2px solid var(--fl-border)', paddingLeft: 10, marginTop: 4 }}>
                <label style={label}>문자셋 (요청 인코딩 · 응답 디코딩)</label>
                <select style={field} value={node.charset ?? 'UTF-8'} onChange={(e) => update(id, { charset: e.target.value })}>
                  {CHARSETS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                {node.reqMode === 'client' && (node.charset ?? 'UTF-8') !== 'UTF-8' && (
                  <p style={{ ...hintP, color: 'var(--fl-put)' }}>
                    ⚠ 클라이언트 모드는 브라우저가 요청을 UTF-8로 보내고 응답 디코딩도 브라우저가 처리합니다. 선택한 문자셋은 <b>서버 모드</b>에서 완전히 적용됩니다. (urlencoded/form 요청은 클라이언트 모드에서도 정상)
                  </p>
                )}
                <ReqModeToggle mode={node.reqMode} onChange={(m) => update(id, { reqMode: m })} />
              </div>
            )}

            {/* 프리셋 — 흔한 조합을 한 번에(method+본문 종류) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontWeight: 600, flexShrink: 0 }}>프리셋</span>
              <div style={miniSeg} role="group" aria-label="요청 프리셋">
                {([['get', 'GET'], ['json', 'JSON'], ['form', 'Form'], ['raw', 'Raw']] as const).map(([k, lbl]) => (
                  <button key={k} type="button" onClick={() => applyPreset(k)} style={miniSegBtn(presetKey === k)}
                    title={k === 'get' ? 'GET 조회' : k === 'json' ? 'POST + JSON 본문' : k === 'form' ? 'POST + Form(x-www-form-urlencoded)' : 'POST + Raw 본문'}>{lbl}</button>
                ))}
              </div>
            </div>

            {bodyConvNote && <p style={{ ...hintP, color: 'var(--fl-put)' }}>⚠ {bodyConvNote}</p>}

            {/* === 요청: 쿼리 / 헤더 / 본문 — 탭 대신 항상 보이는 섹션(한눈에) === */}
            <HttpSection title="쿼리 (URL)" badge={paramCount ? String(paramCount) : ''} open={secIsOpen('query')} onToggle={() => toggleSec('query')}
              right={<div style={miniSeg} role="group" aria-label="쿼리 입력 방식">
                <button type="button" onClick={() => switchKvRaw('params', false)} style={miniSegBtn(!node.paramsRaw)}>필드</button>
                <button type="button" onClick={() => switchKvRaw('params', true)} style={miniSegBtn(!!node.paramsRaw)}>Raw</button>
              </div>}>
              {node.paramsRaw ? (
                <div>
                  <textarea style={{ ...mono, minHeight: 90, resize: 'vertical' }} value={node.rawParams ?? ''} onChange={(e) => update(id, { rawParams: e.target.value })} placeholder="a=1&b=2  또는 { } 로 데이터 삽입" />
                  <button onClick={() => setPick('rawParams')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }} title="데이터 삽입"><DataInsertIcon /></button>
                </div>
              ) : (
                <KeyValueEditor rows={fields.params ?? []} onChange={(rows) => setRows('params', rows)} sources={sources} />
              )}
            </HttpSection>

            <HttpSection title="헤더" badge={headerCount ? String(headerCount) : ''} open={secIsOpen('headers')} onToggle={() => toggleSec('headers')}
              right={<div style={miniSeg} role="group" aria-label="헤더 입력 방식">
                <button type="button" onClick={() => switchKvRaw('headers', false)} style={miniSegBtn(!node.headersRaw)}>필드</button>
                <button type="button" onClick={() => switchKvRaw('headers', true)} style={miniSegBtn(!!node.headersRaw)}>Raw</button>
              </div>}>
              {node.headersRaw ? (
                <div>
                  <textarea style={{ ...mono, minHeight: 90, resize: 'vertical' }} value={node.rawHeaders ?? ''} onChange={(e) => update(id, { rawHeaders: e.target.value })} placeholder={'Authorization: Bearer ...\nContent-Type: application/json'} />
                  <button onClick={() => setPick('rawHeaders')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }} title="데이터 삽입"><DataInsertIcon /></button>
                </div>
              ) : (
                <KeyValueEditor rows={fields.headers ?? []} onChange={(rows) => setRows('headers', rows)} sources={sources} />
              )}
            </HttpSection>

            {hasBody ? (
              <HttpSection title="본문 (Body)" badge={bodyFilled ? '•' : ''} open={secIsOpen('body')} onToggle={() => toggleSec('body')}
                right={<select style={{ ...field, width: 'auto', padding: '5px 6px', fontSize: 12 }} value={bodyKind} onChange={(e) => changeBodyType(e.target.value as BodyType)} aria-label="본문 종류">
                  <option value="json">JSON</option>
                  <option value="urlencoded">Form</option>
                  <option value="xml">XML</option>
                  <option value="raw">Raw</option>
                </select>}>
                {contentType && <div style={{ marginBottom: 8 }}><span style={ctChip} title="실제로 전송될 Content-Type (자동)">Content-Type: {contentType}</span></div>}
                {STRUCTURED_BODY.includes(bodyKind) && (
                  <div style={{ ...miniSeg, marginBottom: 10 }} role="group" aria-label="바디 입력 방식">
                    <button type="button" onClick={() => switchBodyMode(false)} style={miniSegBtn(!node.jsonRaw)}>필드</button>
                    <button type="button" onClick={() => switchBodyMode(true)} style={miniSegBtn(!!node.jsonRaw)}>Raw</button>
                  </div>
                )}
                {(bodyKind === 'raw' || bodyKind === 'xml' || (STRUCTURED_BODY.includes(bodyKind) && !!node.jsonRaw)) ? (
                  <div>
                    <textarea style={{ ...mono, minHeight: 130, resize: 'vertical' }} value={node.rawBody ?? ''} onChange={(e) => update(id, { rawBody: e.target.value })} placeholder={rawBodyPlaceholder(bodyKind)} />
                    <button onClick={() => setPick('rawBody')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }} title="데이터 삽입"><DataInsertIcon /></button>
                  </div>
                ) : (
                  <KeyValueEditor rows={fields.body ?? []} onChange={(rows) => setRows('body', rows)} sources={sources} showType={bodyKind === 'json'} />
                )}
              </HttpSection>
            ) : (
              <p style={{ ...hintP }}>ⓘ {method} 요청은 본문을 보내지 않습니다 — 조회 조건은 위 <b>쿼리(URL)</b>에 넣으세요.</p>
            )}

            {/* 응답 섹션 */}
            <HttpSection title="응답 (Response)" badge={normRespType(node.respType)} open={secIsOpen('resp')} onToggle={() => toggleSec('resp')}
              right={<select style={{ ...field, width: 'auto', padding: '5px 6px', fontSize: 12 }} value={normRespType(node.respType)} onChange={(e) => update(id, { respType: e.target.value as RespType })} aria-label="응답 타입">
                {RESP_TYPES.map((r) => <option key={r} value={r}>{respTypeLabel(r)}</option>)}
              </select>}>
              {node.respType === 'query' && (
                <p style={{ ...hintP, marginTop: 0 }}>응답이 URL/쿼리스트링(<code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>…?code=0000&tid=T1</code>)이면 ? 뒤 파라미터가 키-값으로 제공됩니다.</p>
              )}
              {KEYED_RESP.includes(node.respType ?? 'json') ? (
                <>
                  <label style={label}>{respOutputLabel(node.respType)}</label>
                  <OutputsEditor outputs={node.outputs ?? []} onChange={(outputs) => update(id, { outputs })} nodeId={id} />
                  {single?.output && typeof single.output === 'object' && !Array.isArray(single.output) && (
                    <button onClick={populateOutputs} style={{ ...ghostMini, marginTop: 6 }} title="방금 '이 노드만 실행'한 응답의 키를 출력 목록에 채웁니다">↧ 이 응답에서 키 채우기</button>
                  )}
                  <p style={hintP}>응답이 키 구조가 아니거나 파싱 실패 시 전체 본문이 body 키로 제공됩니다. ({'{{ body@이노드 }}'})</p>
                </>
              ) : (
                <>
                  <p style={{ ...hintP, marginTop: 0 }}>{node.respType === 'binary' ? '이진 응답 — 키 추출 없이 본문 전체가 body 값 하나.' : '텍스트 응답 — 키 없이 본문 전체가 body 값 하나. 하위에서 body 로 바인딩.'}</p>
                  {(node.outputs?.length ?? 0) > 0 && (
                    <p style={{ ...hintP, color: 'var(--fl-put)' }}>⚠ 이 타입에서는 기존 출력 키({(node.outputs ?? []).map((o) => o.key).filter(Boolean).join(', ')})가 무시됩니다.</p>
                  )}
                </>
              )}
            </HttpSection>

            {/* 요청 미리보기 — 보이는 것 = 보내는 것 */}
            <button onClick={() => setPreviewOpen((v) => !v)} style={advToggle} aria-expanded={previewOpen}>
              {previewOpen ? '▾' : '▸'} 요청 미리보기 (보이는 것 = 보내는 것)
            </button>
            {previewOpen && (
              <div style={{ marginTop: 4 }}>
                <pre style={singlePre}>{previewText}</pre>
                <button onClick={() => copyText(previewText, '요청 미리보기를 복사했습니다.')} style={{ ...ghostMini, marginTop: 4 }}>복사</button>
              </div>
            )}
          </>
        )}

        {node.type === 'if' && (
          <ConditionEditor
            label="조건식"
            ariaLabel="조건식"
            value={node.condition}
            onChange={(v) => update(id, { condition: v })}
            sources={sources}
            placeholder="{{ id }} != null — { } 로 데이터 삽입"
            emptyWarn="⚠ 조건식이 비어 있습니다 — 비면 항상 거짓(F 분기)으로 처리됩니다."
          >
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>참이면 T 분기, 거짓이면 F 분기로 진행합니다. (SpEL 안전 평가)</p>
          </ConditionEditor>
        )}

        {node.type === 'assert' && (
          <ConditionEditor
            label="검증 조건식"
            ariaLabel="검증 조건식"
            value={node.condition}
            onChange={(v) => update(id, { condition: v })}
            sources={sources}
            placeholder="{{ resultCode }} == '0000' — { } 로 데이터 삽입"
            emptyWarn="⚠ 검증 조건식이 비어 있습니다 — 비면 검증이 항상 실패합니다."
          >
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>
              조건이 <b>거짓이면 이 노드가 실패</b>하고 실행이 FAILED 로 끝납니다(테스트 시나리오의 assert).
              두 값 비교도 가능: <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{'{{ tid@노티 }} == {{ tid@승인 }}'}</code>
            </p>
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 6 }}>
              <b>HTTP 상태 검증</b>: HTTP 노드는 <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{'{{ httpStatus@노드 }}'}</code> 로
              상태코드를 바인딩합니다 — 예: <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{'{{ httpStatus@조회 }} == 200'}</code> /
              <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{' != 404'}</code>. (SimpleEvaluationContext 라 비교·산술만 — 메서드 호출은 불가)
            </p>
          </ConditionEditor>
        )}

        {node.type === 'set' && (
          <VarsEditor vars={node.vars ?? []} onChange={(vars) => update(id, { vars })} sources={sources} sourceType={sourceType} />
        )}

        {node.type === 'transform' && (
          <>
            <label style={label}>변환</label>
            <select
              style={field}
              value={node.transformId ?? ''}
              onChange={(e) => {
                if (e.target.value === node.transformId) return // 같은 변환 재선택은 no-op(리셋 방지)
                const tr = (transforms.data ?? []).find((t) => t.id === e.target.value)
                // 같은 입력 키의 기존 값/바인딩은 승계(파괴적 리셋 방지)
                const prev = node.fields?.body ?? []
                const body = (tr?.inputs ?? []).map((io) => {
                  const old = prev.find((f) => f.key === io.key)
                  return { id: newId(), key: io.key, value: old?.value ?? '', ...(old?.bound ? { bound: old.bound } : {}) }
                })
                const keptConfig: Record<string, string> = {}
                for (const p of tr?.params ?? []) if (node.config?.[p.key] != null) keptConfig[p.key] = node.config[p.key]
                update(id, {
                  transformId: e.target.value,
                  config: keptConfig,
                  fields: { params: node.fields?.params ?? [], headers: node.fields?.headers ?? [], body },
                  outputs: (tr?.outputs ?? []).map((o) => ({ key: o.key, type: o.type })),
                })
              }}
            >
              <option value="">선택…</option>
              {(transforms.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            {!node.transformId && <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 6 }}>⚠ 변환을 선택하세요 — 미선택이면 실행 시 실패합니다.</p>}
            {canPlatformAdmin && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: 'var(--fl-primary)', cursor: 'pointer' }}>
                ⬆ JAR 플러그인 업로드
                <input
                  type="file"
                  accept=".jar"
                  style={{ display: 'none' }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (file) {
                      try {
                        await pluginsApi.upload(file)
                        qc.invalidateQueries({ queryKey: ['transforms'] })
                        toast('플러그인이 업로드되어 즉시 반영되었습니다.', 'ok')
                      } catch (err) {
                        toast(`플러그인 업로드 실패: ${err instanceof Error ? err.message : err}`, 'error')
                      }
                    }
                    e.target.value = ''
                  }}
                />
              </label>
            )}

            {selectedTransform?.inputs.map((io) => {
              const f = node.fields?.body?.find((x) => x.key === io.key)
              return (
                <div key={io.key}>
                  <label style={label}>입력 · {io.label}</label>
                  {f?.bound && !isTokenizable(f.bound) ? (
                    <BindingChip binding={f.bound} sourceType={sourceType(f.bound)} onRemove={() => setInputField(io.key, { bound: null })} />
                  ) : (
                    <TokenInput
                      ariaLabel={`입력 ${io.label}`}
                      value={f?.bound ? bindingToToken(f.bound) : (f?.value ?? '')}
                      onChange={(v) => setInputField(io.key, { value: v, bound: null })}
                      sources={sources}
                      placeholder="값 또는 { } 로 데이터 삽입"
                    />
                  )}
                </div>
              )
            })}

            {selectedTransform?.params.map((p) => (
              <div key={p.key}>
                <label style={label}>{p.label}</label>
                <input style={field} value={node.config?.[p.key] ?? p.defaultValue} onChange={(e) => update(id, { config: { ...(node.config ?? {}), [p.key]: e.target.value } })} />
              </div>
            ))}

            {selectedTransform && selectedTransform.outputs.length > 0 && (
              <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 10 }}>
                출력: <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{selectedTransform.outputs.map((o) => o.key).join(', ')}</code> — 하위 노드에서 바인딩됩니다.
              </p>
            )}
          </>
        )}

        {node.type === 'tcp' && (
          <>
            <label style={label}>대상 (host:port)</label>
            <input
              style={mono}
              aria-label="대상 host:port"
              value={`${node.tcpHost ?? ''}${node.tcpPort ? ':' + node.tcpPort : ''}`}
              placeholder="10.0.0.5:9999"
              onChange={(e) => {
                const v = e.target.value.trim()
                const ci = v.lastIndexOf(':')
                if (ci > 0) update(id, { tcpHost: v.slice(0, ci), tcpPort: Number(v.slice(ci + 1).replace(/[^0-9]/g, '')) || 0 })
                else update(id, { tcpHost: v, tcpPort: node.tcpPort ?? 0 })
              }}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>인코딩</label>
                <select style={field} value={node.tcpEncoding ?? 'EUC-KR'} onChange={(e) => update(id, { tcpEncoding: e.target.value })}>
                  {['EUC-KR', 'MS949', 'UTF-8', 'US-ASCII'].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}><label style={label}>타임아웃(ms)</label><input style={field} type="number" value={node.tcpTimeoutMs ?? 5000} onChange={(e) => update(id, { tcpTimeoutMs: Number(e.target.value) })} /></div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div><label style={label}>길이 프리픽스(바이트)</label><input style={{ ...field, width: 100 }} type="number" value={node.tcpPrefixLength ?? 0} onChange={(e) => update(id, { tcpPrefixLength: Number(e.target.value) })} /></div>
              <label style={{ fontSize: 12, color: 'var(--fl-text-muted)', display: 'flex', alignItems: 'center', gap: 5, paddingBottom: 9 }}>
                <input type="checkbox" checked={!!node.tcpPrefixIncludesSelf} onChange={(e) => update(id, { tcpPrefixIncludesSelf: e.target.checked })} /> 프리픽스 포함 길이
              </label>
            </div>

            <label style={label}>요청 필드 (고정길이 · 위→아래 순서로 연결)</label>
            <TcpReqEditor fields={node.tcpRequest ?? []} sources={sources} sourceType={sourceType} onChange={(r) => update(id, { tcpRequest: r })} />

            <label style={label}>응답 필드 (고정길이 → 출력)</label>
            <TcpRespEditor
              fields={node.tcpResponse ?? []}
              onChange={(r) => update(id, {
                tcpResponse: r,
                // 응답 필드 이름 = 출력 키 — 바인딩 피커 칩과 자동 동기화
                outputs: r.filter((f) => f.name && f.name.trim()).map((f) => ({ key: f.name!, type: 'string' })),
              })}
            />
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>응답 필드 이름이 그대로 출력 키가 되어 하위 노드에서 바인딩됩니다. 내장 Mock 서버의 TCP 탭으로 가짜 대상 시스템을 세울 수 있습니다.</p>
          </>
        )}

        {node.type === 'form' && (
          <>
            <label style={label}>열기 URL — 팝업/iframe 으로 열어 form 을 제출할 주소</label>
            <TokenInput
              ariaLabel="열기 URL"
              value={node.formAction ?? ''}
              onChange={(v) => update(id, { formAction: v })}
              sources={sources}
              placeholder="https://pg.example.com/pay — { } 로 데이터 삽입"
            />
            {!((node.formAction ?? '').trim()) && <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 6 }}>⚠ 열기 URL 이 비어 있습니다 — 비면 이 노드가 실행 시 실패합니다.</p>}
            <label style={label}>메서드</label>
            <select style={{ ...field, width: 'auto' }} value={node.formMethod ?? 'POST'} onChange={(e) => update(id, { formMethod: e.target.value })}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
            </select>
            <label style={label}>표시 방식</label>
            <div style={miniSeg} role="group" aria-label="표시 방식">
              <button type="button" onClick={() => update(id, { formDisplay: 'popup' })} style={miniSegBtn((node.formDisplay ?? 'popup') === 'popup')}>팝업 창</button>
              <button type="button" onClick={() => update(id, { formDisplay: 'iframe' })} style={miniSegBtn(node.formDisplay === 'iframe')}>iframe 모달</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0 5px' }}>
              <label style={{ ...label, margin: 0 }}>Hidden 필드 (값마다 바인딩 가능)</label>
              <div style={miniSeg} role="group" aria-label="폼 데이터 입력 방식">
                <button type="button" onClick={() => switchFormRaw(false)} style={miniSegBtn(!node.jsonRaw)}>필드</button>
                <button type="button" onClick={() => switchFormRaw(true)} style={miniSegBtn(!!node.jsonRaw)}>Raw</button>
              </div>
            </div>
            {bodyConvNote && <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 0 }}>⚠ {bodyConvNote}</p>}
            {node.jsonRaw ? (
              <div>
                <textarea style={{ ...mono, minHeight: 100, resize: 'vertical' }} value={node.rawBody ?? ''} onChange={(e) => update(id, { rawBody: e.target.value })} placeholder="field1=value1&field2=value2  또는 { } 로 데이터 삽입" />
                <button onClick={() => setPick('rawBody')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }} title="데이터 삽입"><DataInsertIcon /></button>
              </div>
            ) : (
              <KeyValueEditor rows={node.fields?.body ?? []} onChange={(rows) => update(id, { fields: { params: fields.params ?? [], headers: fields.headers ?? [], body: rows } })} sources={sources} />
            )}
            <p style={hintP}>
              실행 시 선택한 방식(<b>팝업 창</b> 또는 <b>페이지 내 iframe 모달</b>)으로 결제창을 열고 숨김 폼을 자동 제출한 뒤
              <b>기다리지 않고 즉시 다음 노드로</b> 진행합니다.
              사람의 인증/입력 결과는 다음 <b>콜백 대기</b> 노드가 받습니다 — 게이트웨이가 요구하는 필드명(returnUrl 등)의
              값에 {'{ }'} 로 <b>콜백 대기 노드의 수신 URL</b> 을 꽂는 것이 표준 패턴입니다.
              <b>iframe</b> 모드는 팝업 차단이 없고 같은 페이지에 뜹니다(✕·바깥 클릭으로 닫기). <b>팝업</b> 모드는 차단 시 실패합니다.
            </p>
          </>
        )}

        {node.type === 'wait' && (
          <>
            <label style={label}>타임아웃 (초)</label>
            <input
              style={{ ...field, width: 120 }}
              type="number"
              min={1}
              value={node.waitTimeoutSec ?? 120}
              onChange={(e) => update(id, { waitTimeoutSec: Math.max(1, Number(e.target.value) || 120) })}
            />
            <p style={{ ...hintP, marginTop: 6 }}>시간 안에 콜백이 없으면 노드 실패 → 실행이 중단됩니다.</p>

            <label style={label}>콜백에 줄 응답</label>
            <select style={{ ...field, width: 'auto' }} value={node.callbackRespType ?? 'text'} onChange={(e) => update(id, { callbackRespType: e.target.value })}>
              {CALLBACK_RESP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            <textarea
              style={{ ...mono, minHeight: 80, resize: 'vertical', marginTop: 6 }}
              value={node.callbackRespBody ?? ''}
              onChange={(e) => update(id, { callbackRespBody: e.target.value })}
              placeholder={node.callbackRespType === 'html' ? '<b>인증 완료 — 창을 닫으세요</b>' : 'OK'}
            />
            <p style={{ ...hintP, marginTop: 6 }}>
              콜백(리다이렉트/노티)을 보낸 쪽이 받을 응답입니다. 인증 callback 이면 HTML("창을 닫으세요"),
              승인 알림 콜백이면 OK 같은 문자열. 콜백 수신 시 백엔드가 이 응답을 돌려줍니다.
            </p>

            <WaitReceiveUrl nodeId={id} />

            <label style={label}>응답 규격 (출력) — 콜백 본문 키 (하위 노드가 바인딩)</label>
            <OutputsEditor outputs={node.outputs ?? []} onChange={(outputs) => update(id, { outputs })} nodeId={id} />
            <p style={hintP}>
              선언은 바인딩 피커 칩용입니다 — 실제로는 콜백 본문(JSON/urlencoded 파싱)의 <b>모든</b> 키가 출력이 되고,
              키 구조가 아니면 원문이 body 로 제공됩니다. 수신 URL 은 <code>{`{{ url@${id} }}`}</code> 로 어느 노드에서든 바인딩됩니다.
            </p>
          </>
        )}

        {node.type === 'input' && (
          <>
            <label style={label}>안내 메시지 — 입력 창에 표시 ({'{ }'} 토큰 가능)</label>
            <textarea
              style={{ ...field, minHeight: 60, resize: 'vertical' }}
              value={node.waitMsg ?? ''}
              onChange={(e) => update(id, { waitMsg: e.target.value })}
              placeholder="휴대폰으로 받은 OTP를 입력하세요"
            />
            <button onClick={() => setPick('waitMsg')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }} title="데이터 삽입"><DataInsertIcon /></button>
            <label style={label}>입력 필드 (키 · 라벨 · 타입)</label>
            <WaitFieldsEditor fields={node.waitFields ?? []} onChange={(waitFields) => update(id, { waitFields })} />
            {(node.waitFields ?? []).filter((f) => f.key?.trim()).length === 0 && <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 6 }}>⚠ 입력 필드가 없습니다 — 최소 1개(키)를 추가하세요.</p>}
            <p style={hintP}>
              실행이 이 노드에 도달하면 <b>입력 창</b>이 뜨고, 값을 입력해 확인하면 각 키가 이 노드의 출력이 되어
              다음 노드에서 <code>{'{{ 키@' + id + ' }}'}</code> 로 바인딩됩니다. 타입이 <code>json</code> 이면
              객체/배열도 그대로 전달됩니다(예: <code>{'{"a":1}'}</code>). 취소(Esc)는 실행 중단.
            </p>
          </>
        )}

        {(node.type === 'start' || node.type === 'end') && (
          <p style={{ fontSize: 13, color: 'var(--fl-text-muted)', marginTop: 14 }}>이 노드는 추가 설정이 없습니다.</p>
        )}

        {node.type !== 'start' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 28 }}>
            <button onClick={() => duplicateSelection()} style={{ ...deleteBtn, marginTop: 0, flex: 1, borderColor: 'var(--fl-border)', color: 'var(--fl-text-muted)' }} title="이 노드 복제 (Ctrl+D)">⧉ 복제</button>
            <button onClick={() => deleteNode(id)} style={{ ...deleteBtn, marginTop: 0, flex: 1 }}>이 노드 삭제</button>
          </div>
        )}
        {node.type === 'start' && (
          <button onClick={() => deleteNode(id)} style={deleteBtn}>이 노드 삭제</button>
        )}
      </div>

      {pick && <BindingPicker sources={sources} onClose={() => setPick(null)} onPick={onPick} />}
    </aside>
  )
}

function ReqModeToggle({ mode, onChange }: { mode?: ReqMode; onChange: (m: ReqMode) => void }) {
  const isClient = mode === 'client'
  return (
    <>
      <label style={label}>요청 방식</label>
      <div style={segWrap}>
        <button type="button" onClick={() => onChange('server')} style={segBtn(!isClient, 'var(--fl-primary)')}>
          <ServerIcon /> 서버 → 서버
        </button>
        <button type="button" onClick={() => onChange('client')} style={segBtn(isClient, '#0ea5a4')}>
          <ClientIcon /> 클라이언트 → 서버
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8, lineHeight: 1.5 }}>
        {isClient
          ? '브라우저(클라이언트)에서 직접 이 API를 호출합니다. 토큰·세션이 클라이언트에 노출될 수 있습니다.'
          : '서버가 대신 이 API를 호출합니다. 인증 정보가 외부에 노출되지 않아 민감한 요청에 적합합니다.'}
      </p>
    </>
  )
}

function ServerIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="4" width="16" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <rect x="4" y="13.5" width="16" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="7.5" cy="7.2" r="1" fill="currentColor" />
      <circle cx="7.5" cy="16.7" r="1" fill="currentColor" />
    </svg>
  )
}

function ClientIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="5" width="18" height="12" rx="1.8" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/** input(사용자 입력) 노드의 입력 필드 정의 편집기 — 키가 그대로 출력 키가 된다. */
function WaitFieldsEditor({ fields, onChange }: { fields: WaitFieldT[]; onChange: (f: WaitFieldT[]) => void }) {
  const upd = (fid: string, patch: Partial<WaitFieldT>) => onChange(fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)))
  return (
    <>
      {fields.map((f, i) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={{ ...mono, flex: 1 }} value={f.key} placeholder="키(=출력)" onChange={(e) => upd(f.id, { key: e.target.value })} />
          <input style={{ ...field, flex: 1 }} value={f.label ?? ''} placeholder="라벨(표시)" onChange={(e) => upd(f.id, { label: e.target.value })} />
          <select style={{ ...field, width: 84 }} value={f.type ?? 'string'} onChange={(e) => upd(f.id, { type: e.target.value })}>
            {['string', 'number', 'boolean', 'json'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <RowMove i={i} len={fields.length} onMove={(d) => onChange(moveInList(fields, i, d))} />
          <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 26, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...fields, { id: newId(), key: '', label: '', type: 'string' }])} style={addDashed}>+ 입력 필드</button>
    </>
  )
}

/** wait 노드 수신 URL 표시 + 바인딩 토큰 복사. 콜백은 백엔드가 직접 받아 재개한다. */
function WaitReceiveUrl({ nodeId }: { nodeId: string }) {
  // 설정(콜백 수신 주소)의 실제 적용값으로 표시 — 사이드바 ⚙ 설정에서 저장/수정, 기본은 접속 주소 자동
  const relay = useQuery({ queryKey: ['settings', 'relay'], queryFn: settingsApi.relay })
  const pattern = `${relay.data?.effective ?? '{백엔드}'}/relay/{실행ID}/cb/${nodeId}`
  const token = `{{ url@${nodeId} }}`
  return (
    <>
      <label style={label}>수신 URL — 이 주소로 콜백을 보내면 진행됩니다</label>
      <div style={{ display: 'flex', gap: 4 }}>
        <input style={mono} readOnly value={pattern} onFocus={(e) => e.currentTarget.select()} title="실행ID는 실행마다 새로 생성됩니다 — 정확한 주소는 실행 로그에 표시됩니다" />
        <button
          onClick={() => { void navigator.clipboard?.writeText(token).catch(() => {}) }}
          title={`바인딩 토큰 복사 — ${token}`}
          style={{ ...braceBtn, width: 'auto', padding: '0 10px', whiteSpace: 'nowrap' }}
        ><CopyIcon /></button>
      </div>
      <p style={{ ...hintP, marginTop: 6 }}>
        실행 시작 시 실행ID가 생성되어 URL 이 확정됩니다(정확한 주소는 실행 로그에 표시). 앞 노드(결제요청의 returnUrl/notiUrl 등)에서
        {'{ }'} 피커의 <b>수신 URL</b> 항목 또는 위 토큰으로 꽂아 쓰세요. 콜백은 <b>백엔드가 직접 받아</b> 실행을 재개합니다.
      </p>
    </>
  )
}

function appendCond(cond: string | undefined, s: string): string {
  const c = (cond ?? '').trim()
  return c ? `${c} ${s}` : s
}
/**
 * IF·ASSERT 공용 조건식 편집기 — 라벨 + 토큰 입력 + 빠른 삽입 스니펫 + 빈-조건 경고.
 * 두 노드가 같은 SpEL 조건 UI 를 쓰므로 한 곳으로 통합(중복 제거). 노드별 안내는 children 으로.
 */
function ConditionEditor({
  label: lbl, ariaLabel, value, onChange, sources, placeholder, emptyWarn, children,
}: {
  label: string
  ariaLabel: string
  value: string | undefined
  onChange: (v: string) => void
  sources: BindableSource[]
  placeholder: string
  emptyWarn: string
  children?: ReactNode
}) {
  return (
    <>
      <label style={label}>{lbl}</label>
      <TokenInput ariaLabel={ariaLabel} value={value ?? ''} onChange={onChange} sources={sources} placeholder={placeholder} />
      <CondSnippets onInsert={(s) => onChange(appendCond(value, s))} />
      {!((value ?? '').trim()) && <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 6 }}>{emptyWarn}</p>}
      {children}
    </>
  )
}
// IF/ASSERT 조건식 자주 쓰는 비교 스니펫 — 클릭하면 조건식 끝에 붙는다.
function CondSnippets({ onInsert }: { onInsert: (s: string) => void }) {
  const snips = ['!= null', '== 200', '!= 404', "== '0000'", '== true']
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
      <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', alignSelf: 'center' }}>빠른 삽입:</span>
      {snips.map((s) => (
        <button key={s} type="button" onClick={() => onInsert(s)} title={`조건식 끝에 "${s}" 추가`} style={snippetChip}>{s}</button>
      ))}
    </div>
  )
}

function OutputsEditor({ outputs, onChange, nodeId }: { outputs: NodeOutput[]; onChange: (o: NodeOutput[]) => void; nodeId?: string }) {
  const upd = (i: number, patch: Partial<NodeOutput>) => onChange(outputs.map((o, idx) => (idx === i ? { ...o, ...patch } : o)))
  return (
    <>
      {outputs.map((o, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input style={{ ...mono, flex: 1 }} value={o.key} placeholder="키" onChange={(e) => upd(i, { key: e.target.value })} />
          <select style={{ ...field, width: 96 }} value={o.type ?? 'string'} onChange={(e) => upd(i, { type: e.target.value })}>
            {OUTPUT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {nodeId && o.key?.trim() && (
            <button
              onClick={() => { void navigator.clipboard?.writeText(`{{ ${o.key}@${nodeId} }}`).then(() => toast(`{{ ${o.key}@${nodeId} }} 복사`, 'ok')).catch(() => {}) }}
              aria-label="바인딩 토큰 복사" title={`{{ ${o.key}@${nodeId} }} 복사 — 하위 노드에 붙여넣기`}
              style={{ width: 30, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            ><CopyIcon /></button>
          )}
          <RowMove i={i} len={outputs.length} onMove={(d) => onChange(moveInList(outputs, i, d))} />
          <button onClick={() => onChange(outputs.filter((_, idx) => idx !== i))} aria-label="삭제" style={{ width: 28, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...outputs, { key: '', type: 'string' }])} style={addDashed}>+ 출력 항목</button>
    </>
  )
}

function VarsEditor({ vars, onChange, sources, sourceType }: { vars: NodeVar[]; onChange: (v: NodeVar[]) => void; sources: BindableSource[]; sourceType: (b: Binding) => string | undefined }) {
  // 시크릿 행은 마스킹(password) 유지가 우선이라 인라인 칩 대신 기존 [값|칩 + { }] 방식을 유지한다.
  const [pickVar, setPickVar] = useState<string | null>(null)
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const toggleReveal = (vid: string) => setRevealed((p) => { const n = new Set(p); if (n.has(vid)) n.delete(vid); else n.add(vid); return n })
  const upd = (vid: string, patch: Partial<NodeVar>) => onChange(vars.map((v) => (v.id === vid ? { ...v, ...patch } : v)))
  return (
    <>
      <label style={label}>변수</label>
      {vars.map((v) => (
        <div key={v.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={{ ...mono, flex: 1 }} value={v.key} placeholder="key" onChange={(e) => upd(v.id, { key: e.target.value })} />
          {v.secret ? (
            v.bound ? (
              <div style={{ flex: 1 }}><BindingChip binding={v.bound} sourceType={sourceType(v.bound)} onRemove={() => upd(v.id, { bound: null })} onClick={() => setPickVar(v.id)} /></div>
            ) : (
              <>
                <input style={{ ...mono, flex: 1 }} type={revealed.has(v.id) ? 'text' : 'password'} value={v.value ?? ''} placeholder="value" onChange={(e) => upd(v.id, { value: e.target.value })} />
                <button onClick={() => toggleReveal(v.id)} title={revealed.has(v.id) ? '값 숨기기' : '값 보기'} aria-label={revealed.has(v.id) ? '값 숨기기' : '값 보기'} style={braceBtn}>{revealed.has(v.id) ? '🙈' : '👁'}</button>
                <button onClick={() => setPickVar(v.id)} title="데이터 삽입" style={braceBtn}><DataInsertIcon /></button>
              </>
            )
          ) : v.bound && !isTokenizable(v.bound) ? (
            <div style={{ flex: 1 }}><BindingChip binding={v.bound} sourceType={sourceType(v.bound)} onRemove={() => upd(v.id, { bound: null })} /></div>
          ) : (
            <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
              <TokenInput
                ariaLabel={`변수 ${v.key || 'value'}`}
                value={v.bound ? bindingToToken(v.bound) : (v.value ?? '')}
                onChange={(val) => upd(v.id, { value: val, bound: null })}
                sources={sources}
                placeholder="value 또는 { } 로 삽입"
              />
            </div>
          )}
          <label title="시크릿(마스킹)" style={{ fontSize: 11, color: 'var(--fl-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={!!v.secret} onChange={(e) => upd(v.id, { secret: e.target.checked })} />🔒
          </label>
          <button onClick={() => onChange(vars.filter((x) => x.id !== v.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
          {pickVar === v.id && (
            <BindingPicker sources={sources} onClose={() => setPickVar(null)} onPick={(b) => { upd(v.id, { bound: b, value: '' }); setPickVar(null) }} />
          )}
        </div>
      ))}
      <button onClick={() => onChange([...vars, { id: newId(), key: '', value: '', secret: false }])} style={addDashed}>+ 변수 추가</button>
    </>
  )
}


// 목록 행 위/아래 이동 — 순서가 load-bearing 인 편집기(TCP 바이트 배치·출력·입력)에서 재정렬용
function moveInList<T>(arr: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir
  if (j < 0 || j >= arr.length) return arr
  const next = arr.slice()
  const tmp = next[i]; next[i] = next[j]; next[j] = tmp
  return next
}
function RowMove({ i, len, onMove }: { i: number; len: number; onMove: (dir: -1 | 1) => void }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', flexShrink: 0 }}>
      <button onClick={() => onMove(-1)} disabled={i === 0} aria-label="위로" title="위로" style={rowMoveBtn(i === 0)}>▲</button>
      <button onClick={() => onMove(1)} disabled={i === len - 1} aria-label="아래로" title="아래로" style={rowMoveBtn(i === len - 1)}>▼</button>
    </span>
  )
}

/** TCP 요청 필드 편집기 — 값은 텍스트+토큰 칩 혼합(TokenInput), 토큰화 불가 bound 는 구조적 칩 유지. */
function TcpReqEditor({ fields, sources, sourceType, onChange }: { fields: TcpField[]; sources: BindableSource[]; sourceType: (b: Binding) => string | undefined; onChange: (f: TcpField[]) => void }) {
  const upd = (fid: string, patch: Partial<TcpField>) => onChange(fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)))
  let off = 0
  const total = fields.reduce((a, f) => a + (f.length ?? 0), 0)
  return (
    <>
      {fields.map((f, i) => {
        const start = off; off += f.length ?? 0
        return (
        <div key={f.id} style={{ border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 8, marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <span title={`시작 바이트 오프셋 ${start} (길이 ${f.length ?? 0})`} style={offBadge}>@{start}</span>
            <input style={{ ...mono, flex: 2 }} value={f.name ?? ''} placeholder="이름" onChange={(e) => upd(f.id, { name: e.target.value })} />
            <input style={{ ...mono, width: 54 }} type="number" value={f.length ?? 0} title="바이트 길이" onChange={(e) => upd(f.id, { length: Number(e.target.value) })} />
            <select style={{ ...field, width: 50 }} value={f.pad ?? 'right'} title="패딩 방향" onChange={(e) => upd(f.id, { pad: e.target.value as 'left' | 'right' })}>
              <option value="right">→</option>
              <option value="left">←</option>
            </select>
            <input style={{ ...mono, width: 34 }} maxLength={1} value={f.padChar ?? ' '} title="패딩 문자" onChange={(e) => upd(f.id, { padChar: e.target.value })} />
            <RowMove i={i} len={fields.length} onMove={(d) => onChange(moveInList(fields, i, d))} />
            <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 26, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
          </div>
          {f.bound && !isTokenizable(f.bound) ? (
            <BindingChip binding={f.bound} sourceType={sourceType(f.bound)} onRemove={() => upd(f.id, { bound: null })} />
          ) : (
            <TokenInput
              ariaLabel={`TCP 필드 ${f.name || ''}`}
              value={f.bound ? bindingToToken(f.bound) : (f.value ?? '')}
              onChange={(v) => upd(f.id, { value: v, bound: null })}
              sources={sources}
              placeholder="값 또는 { } 로 데이터 삽입"
            />
          )}
        </div>
      ) })}
      <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', margin: '2px 0 6px', fontFamily: 'var(--fl-font-mono)' }}>총 {total} 바이트</div>
      <button onClick={() => onChange([...fields, { id: newId(), name: '', length: 10, value: '', pad: 'right', padChar: ' ' }])} style={addDashed}>+ 요청 필드</button>
    </>
  )
}

function TcpRespEditor({ fields, onChange }: { fields: TcpRespField[]; onChange: (f: TcpRespField[]) => void }) {
  const upd = (fid: string, patch: Partial<TcpRespField>) => onChange(fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)))
  let off = 0
  const total = fields.reduce((a, f) => a + (f.length ?? 0), 0)
  return (
    <>
      {fields.map((f, i) => {
        const start = off; off += f.length ?? 0
        return (
        <div key={f.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <span title={`시작 바이트 오프셋 ${start} (길이 ${f.length ?? 0})`} style={offBadge}>@{start}</span>
          <input style={{ ...mono, flex: 2 }} value={f.name ?? ''} placeholder="이름(=출력 키)" onChange={(e) => upd(f.id, { name: e.target.value })} />
          <input style={{ ...mono, width: 64 }} type="number" value={f.length ?? 0} title="바이트 길이" onChange={(e) => upd(f.id, { length: Number(e.target.value) })} />
          <RowMove i={i} len={fields.length} onMove={(d) => onChange(moveInList(fields, i, d))} />
          <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 26, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ) })}
      <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', margin: '2px 0 6px', fontFamily: 'var(--fl-font-mono)' }}>총 {total} 바이트</div>
      <button onClick={() => onChange([...fields, { id: newId(), name: '', length: 10 }])} style={addDashed}>+ 응답 필드</button>
    </>
  )
}

const shell: CSSProperties = { flexShrink: 0, background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', height: '100%' }
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
const iconBtn: CSSProperties = { width: 30, height: 30, flexShrink: 0, borderRadius: 8, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 14 }
const singleBtn: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-primary)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }
const singlePre: CSSProperties = { margin: 0, padding: '8px 10px', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text)', background: 'var(--fl-surface)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }
const deleteBtn: CSSProperties = { marginTop: 28, width: '100%', padding: '9px', border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const addDashed: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
const hintP: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 12, lineHeight: 1.5 }
// URL 행의 메서드 셀렉트 — 좁은 고정폭 + 메서드 색 강조(모노)
function methodSel(m?: string): CSSProperties {
  return { ...field, width: 82, flexShrink: 0, fontFamily: 'var(--fl-font-mono)', fontWeight: 700, color: METHOD_COLOR[(m ?? 'GET') as HttpMethod] ?? 'var(--fl-text)', padding: '8px 6px' }
}
const ghostMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 500 }
const smartLink: CSSProperties = { marginTop: 6, padding: '4px 8px', border: 'none', background: 'transparent', color: 'var(--fl-primary)', cursor: 'pointer', fontSize: 12, fontWeight: 600, textAlign: 'left' }
const snippetChip: CSSProperties = { padding: '2px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)' }
const offBadge: CSSProperties = { flexShrink: 0, fontSize: 10, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', borderRadius: 4, padding: '2px 4px', minWidth: 26, textAlign: 'center' }
function rowMoveBtn(disabled: boolean): CSSProperties {
  return { width: 18, height: 11, border: 'none', background: 'transparent', color: disabled ? 'var(--fl-border)' : 'var(--fl-text-muted)', cursor: disabled ? 'default' : 'pointer', fontSize: 8, lineHeight: '11px', padding: 0 }
}
const advToggle: CSSProperties = { marginTop: 12, padding: '4px 0', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12, fontWeight: 600, textAlign: 'left', width: '100%', display: 'block' }
// 연결(바로가기) 이웃 노드 칩
const navChip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12, maxWidth: 160 }
// HTTP 요청 3파트 통합 — 탭 대신 항상 보이는 접을 수 있는 섹션(쿼리/헤더/본문/응답)
const secHeadBtn: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, padding: 0 }
const secBadge: CSSProperties = { marginLeft: 4, fontSize: 10.5, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-primary)', fontWeight: 600 }
const ctChip: CSSProperties = { fontSize: 10, fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 5, padding: '2px 6px', whiteSpace: 'nowrap', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }
function HttpSection({ title, badge, open, onToggle, right, children }: {
  title: string; badge?: string; open: boolean; onToggle: () => void; right?: ReactNode; children: ReactNode
}) {
  return (
    <div style={{ borderTop: '1px solid var(--fl-border)', marginTop: 10, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
        <button onClick={onToggle} aria-expanded={open} style={secHeadBtn}>
          <span aria-hidden style={{ width: 10, display: 'inline-block', fontSize: 10, color: 'var(--fl-text-muted)' }}>{open ? '▾' : '▸'}</span>
          {title}
          {badge ? <span style={secBadge}>{badge === '•' ? '•' : `(${badge})`}</span> : null}
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>{right}</div>
      </div>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  )
}
const miniSeg: CSSProperties = { display: 'inline-flex', gap: 2, background: 'var(--fl-surface-2)', borderRadius: 7, padding: 2, flexShrink: 0 }
function miniSegBtn(active: boolean): CSSProperties {
  return {
    padding: '5px 12px', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--fl-surface)' : 'transparent',
    color: active ? 'var(--fl-primary)' : 'var(--fl-text-muted)',
    boxShadow: active ? 'var(--fl-shadow)' : 'none',
  }
}
const segWrap: CSSProperties = { display: 'flex', gap: 4, background: 'var(--fl-surface-2)', borderRadius: 9, padding: 3 }
function segBtn(active: boolean, color: string): CSSProperties {
  return {
    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    fontWeight: 600, fontSize: 12, border: 'none', borderRadius: 7, padding: '7px 6px', cursor: 'pointer',
    background: active ? 'var(--fl-surface)' : 'transparent',
    color: active ? color : 'var(--fl-text-muted)',
    boxShadow: active ? 'var(--fl-shadow)' : 'none',
  }
}
