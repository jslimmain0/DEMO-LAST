import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { pluginsApi, transformsApi } from '../api/client'
import type { Binding, BodyType, GraphNode, HttpMethod, NodeField, NodeOutput, NodeVar, ReqMode, RespType, TcpField, TcpRespField, WaitField as WaitFieldT } from '../api/types'
import { BindingChip } from '../binding/BindingChip'
import { BindingPicker } from '../binding/BindingPicker'
import { TokenInput } from '../binding/TokenInput'
import { bindableSources } from '../binding/upstream'
import type { BindableSource } from '../binding/upstream'
import { asGraphNode } from '../canvas/graphAdapter'
import { catColor, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { fieldsToRaw, rawToFields, headersToRaw, rawToHeaders } from '../lib/bodyConvert'
import { bindingToToken, isTokenizable } from '../lib/tokenGrammar'
import { newId } from '../lib/ids'
import { useEditorStore } from '../store/editorStore'
import { KeyValueEditor } from './KeyValueEditor'

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '12px 0 5px' }
const field: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, fontFamily: 'var(--fl-font-ui)' }
const mono: CSSProperties = { ...field, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }
const braceBtn: CSSProperties = { width: 32, height: 32, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', fontFamily: 'var(--fl-font-mono)', fontSize: 12 }

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
// wait(콜백 대기) 노드 — 콜백에 줄 응답 형식
const CALLBACK_RESP_TYPES = [
  { value: 'text', label: '문자열 (text/plain)' },
  { value: 'html', label: 'HTML (text/html)' },
  { value: 'json', label: 'JSON (application/json)' },
]
const BODY_TYPES: BodyType[] = ['json', 'urlencoded', 'form', 'raw', 'xml']
// 구조형 바디(키-값 또는 raw 텍스트 둘 다 가능) — jsonRaw 플래그로 [필드|Raw] 전환
const STRUCTURED_BODY: BodyType[] = ['json', 'urlencoded', 'form']
function rawBodyPlaceholder(bt: BodyType | undefined): string {
  if (bt === 'urlencoded' || bt === 'form') return 'a=1&b=2  또는 { } 로 데이터 삽입'
  if (bt === 'xml') return '<root> ... </root>  또는 { } 로 데이터 삽입'
  return '{ "key": "value" }  또는 { } 로 데이터 삽입'
}
const RESP_TYPES: RespType[] = ['json', 'xml', 'urlencoded', 'form', 'query', 'text', 'binary']
const CHARSETS = ['UTF-8', 'EUC-KR', 'MS949', 'US-ASCII']
const OUTPUT_TYPES = ['string', 'int', 'number', 'boolean', 'object', 'array', 'secret']

// 키형(json/xml/urlencoded/form/query): 응답이 키-값 구조라 "예상 응답 키"가 의미 있음 → 하위 노드가 키로 바인딩.
// 통짜형(text/binary): 키가 없으므로 응답 본문 전체가 단일 값(body)으로만 제공됨.
const KEYED_RESP: RespType[] = ['json', 'xml', 'urlencoded', 'form', 'query']
function respTypeLabel(rt: RespType): string {
  return rt === 'query' ? 'query (URL/쿼리 파라미터)' : rt
}
function respOutputLabel(rt: RespType | undefined): string {
  if (rt === 'xml') return '응답 요소 (XML) — 하위 노드가 바인딩할 항목'
  if (rt === 'urlencoded' || rt === 'form') return '응답 필드 (urlencoded 키) — 하위 노드가 바인딩할 항목'
  if (rt === 'query') return '응답 필드 (쿼리 파라미터) — 하위 노드가 바인딩할 항목'
  return '예상 응답 필드 (JSON 키) — 하위 노드가 바인딩할 항목'
}

export function PropertyPanel({ width = 360 }: { width?: number }) {
  const selectedId = useEditorStore((s) => s.selectedId)
  const nodes = useEditorStore((s) => s.nodes)
  const edges = useEditorStore((s) => s.edges)
  const update = useEditorStore((s) => s.updateNodeData)
  const selectNode = useEditorStore((s) => s.selectNode)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const [tab, setTab] = useState<'params' | 'headers' | 'body'>('params')
  const [pick, setPick] = useState<string | null>(null) // rawBody | rawParams | rawHeaders (Raw 텍스트영역 전용)
  const [bodyConvNote, setBodyConvNote] = useState<string | null>(null) // 필드↔Raw 변환 안내
  const transforms = useQuery({ queryKey: ['transforms'], queryFn: transformsApi.list })
  const qc = useQueryClient()

  const node = useMemo<GraphNode | null>(() => {
    const n = nodes.find((x) => x.id === selectedId)
    return n ? asGraphNode(n.data) : null
  }, [nodes, selectedId])

  // 조상 소스 + 그래프 내 wait 노드 수신 URL(앞 노드에서 returnUrl/notiUrl 에 꽂는 표준 패턴)
  const sources: BindableSource[] = useMemo(
    () => (selectedId ? bindableSources(nodes, edges, selectedId) : []),
    [nodes, edges, selectedId],
  )

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
    setPick(null)
  }

  return (
    <aside aria-label="속성" style={{ ...shell, width }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden style={{ color: catColor(node.cat), fontSize: 16 }}>{typeIcon(node.type)}</span>
        <input aria-label="노드 이름" value={node.name ?? ''} onChange={(e) => update(id, { name: e.target.value })} style={{ ...field, fontWeight: 600, fontFamily: 'var(--fl-font-head)' }} />
        <button onClick={() => selectNode(null)} aria-label="패널 닫기" style={closeBtn}>×</button>
      </header>

      <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
        <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{typeLabel(node.type)} · #{id}</div>

        {node.type === 'http' && (
          <>
            <label style={label}>메서드</label>
            <select style={field} value={node.method ?? 'GET'} onChange={(e) => update(id, { method: e.target.value as HttpMethod })}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>

            <label style={label}>문자셋 (요청 인코딩 · 응답 디코딩)</label>
            <select style={field} value={node.charset ?? 'UTF-8'} onChange={(e) => update(id, { charset: e.target.value })}>
              {CHARSETS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {node.reqMode === 'client' && (node.charset ?? 'UTF-8') !== 'UTF-8' && (
              <p style={{ ...hintP, color: 'var(--fl-put)' }}>
                ⚠ 클라이언트 모드는 브라우저가 요청을 UTF-8로 보내고 응답 디코딩도 브라우저가 처리합니다. 선택한 문자셋은 <b>서버 모드</b>에서 완전히 적용됩니다. (urlencoded/form 요청은 클라이언트 모드에서도 정상)
              </p>
            )}

            <label style={label}>Base URL</label>
            {node.baseUrlBound && !isTokenizable(node.baseUrlBound) ? (
              // 토큰 문법 밖 키/id 의 구(舊) bound — 이관하면 조용히 깨지므로 구조적 바인딩 칩 유지
              <BindingChip binding={node.baseUrlBound} sourceType={sourceType(node.baseUrlBound)} onRemove={() => update(id, { baseUrlBound: null })} />
            ) : (
              <TokenInput
                ariaLabel="Base URL"
                value={node.baseUrlBound ? bindingToToken(node.baseUrlBound) : (node.baseUrl ?? '')}
                onChange={(v) => update(id, { baseUrl: v, baseUrlBound: null })}
                sources={sources}
                placeholder="https://api.example.com — { } 로 데이터 삽입"
              />
            )}

            <label style={label}>Path</label>
            <TokenInput
              ariaLabel="Path"
              value={node.path ?? ''}
              onChange={(v) => update(id, { path: v })}
              sources={sources}
              placeholder="/resource — { } 로 데이터 삽입"
            />

            <ReqModeToggle mode={node.reqMode} onChange={(m) => update(id, { reqMode: m })} />

            <div style={{ display: 'flex', gap: 4, margin: '16px 0 6px', borderBottom: '1px solid var(--fl-border)' }}>
              {(['params', 'headers', 'body'] as const).map((t) => (
                <button key={t} onClick={() => { setTab(t); setBodyConvNote(null) }} style={tabBtn(tab === t)}>{t === 'params' ? 'Params' : t === 'headers' ? 'Headers' : 'Body'}</button>
              ))}
            </div>
            <p style={{ ...hintP, marginTop: 0 }}>
              {tab === 'params'
                ? 'URL 쿼리스트링 ?key=value — 주소에 붙는 조회 조건 (주로 GET)'
                : tab === 'headers'
                  ? 'HTTP 헤더 — 인증 토큰(Authorization) 등 메타데이터'
                  : '요청 본문(body) — 서버로 보내는 데이터 (주로 POST/PUT/PATCH)'}
            </p>

            {tab === 'body' && (
              <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                <select style={{ ...field, width: 'auto' }} value={node.bodyType ?? 'json'} onChange={(e) => changeBodyType(e.target.value as BodyType)}>
                  {BODY_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                {STRUCTURED_BODY.includes(node.bodyType ?? 'json') && (
                  <div style={miniSeg} role="group" aria-label="바디 입력 방식">
                    <button type="button" onClick={() => switchBodyMode(false)} style={miniSegBtn(!node.jsonRaw)}>필드</button>
                    <button type="button" onClick={() => switchBodyMode(true)} style={miniSegBtn(!!node.jsonRaw)}>Raw</button>
                  </div>
                )}
              </div>
            )}

            {/* Params(쿼리 urlencoded)·Headers(Key: Value)도 [필드 ↔ Raw] 전환 지원 */}
            {(tab === 'params' || tab === 'headers') && (
              <div style={{ marginBottom: 10 }}>
                <div style={miniSeg} role="group" aria-label={tab === 'params' ? '쿼리 입력 방식' : '헤더 입력 방식'}>
                  <button type="button" onClick={() => switchKvRaw(tab, false)} style={miniSegBtn(!(tab === 'params' ? node.paramsRaw : node.headersRaw))}>필드</button>
                  <button type="button" onClick={() => switchKvRaw(tab, true)} style={miniSegBtn(!!(tab === 'params' ? node.paramsRaw : node.headersRaw))}>Raw</button>
                </div>
              </div>
            )}

            {bodyConvNote && (
              <p style={{ ...hintP, color: 'var(--fl-put)', marginTop: 0 }}>⚠ {bodyConvNote}</p>
            )}

            {(tab === 'body'
              ? (node.bodyType === 'raw' || node.bodyType === 'xml' || (STRUCTURED_BODY.includes(node.bodyType ?? 'json') && !!node.jsonRaw))
              : tab === 'params' ? !!node.paramsRaw : !!node.headersRaw) ? (
              <div>
                <textarea
                  style={{ ...mono, minHeight: tab === 'headers' ? 100 : 140, resize: 'vertical' }}
                  value={(tab === 'body' ? node.rawBody : tab === 'params' ? node.rawParams : node.rawHeaders) ?? ''}
                  onChange={(e) => update(id, tab === 'body' ? { rawBody: e.target.value } : tab === 'params' ? { rawParams: e.target.value } : { rawHeaders: e.target.value })}
                  placeholder={tab === 'body' ? rawBodyPlaceholder(node.bodyType) : tab === 'params' ? 'a=1&b=2  또는 { } 로 데이터 삽입' : 'Authorization: Bearer ...\nContent-Type: application/json'}
                />
                <button onClick={() => setPick(tab === 'body' ? 'rawBody' : tab === 'params' ? 'rawParams' : 'rawHeaders')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }}>{'{ } 데이터 삽입'}</button>
              </div>
            ) : (
              <KeyValueEditor rows={fields[tab] ?? []} onChange={(rows) => setRows(tab, rows)} sources={sources} showType={tab === 'body' && (node.bodyType ?? 'json') === 'json'} />
            )}

            <label style={label}>응답 타입</label>
            <select style={field} value={node.respType ?? 'json'} onChange={(e) => update(id, { respType: e.target.value as RespType })}>
              {RESP_TYPES.map((r) => <option key={r} value={r}>{respTypeLabel(r)}</option>)}
            </select>

            {node.respType === 'query' && (
              <p style={{ ...hintP, marginTop: 6 }}>
                응답 본문이 URL(<code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>…?code=0000&tid=T1</code>)
                또는 쿼리스트링이면 <b>? 뒤 파라미터</b>가 키-값으로 제공됩니다 — 리다이렉트/리턴 URL 응답용.
              </p>
            )}

            {KEYED_RESP.includes(node.respType ?? 'json') ? (
              <>
                <label style={label}>{respOutputLabel(node.respType)}</label>
                <OutputsEditor outputs={node.outputs ?? []} onChange={(outputs) => update(id, { outputs })} />
                <p style={hintP}>응답이 키 구조가 아니거나 파싱에 실패하면 전체 본문이 body 키로 제공됩니다. (그 경우 raw/조건식에 {'{{ body@이노드 }}'}로 바인딩)</p>
              </>
            ) : (
              <>
                <p style={hintP}>
                  {node.respType === 'binary'
                    ? '이진 응답이라 키를 추출하지 않습니다. 응답 본문 전체가 body 값 하나로 제공됩니다.'
                    : '텍스트 응답은 키가 없습니다. 응답 본문 전체가 body 값 하나로 제공되며, 하위 노드에서 body로 바인딩하세요.'}
                </p>
                {(node.outputs?.length ?? 0) > 0 && (
                  <p style={{ ...hintP, color: 'var(--fl-put)' }}>
                    ⚠ 이 응답 타입에서는 기존 출력 키({(node.outputs ?? []).map((o) => o.key).filter(Boolean).join(', ')})가 무시됩니다. 하위 노드가 이 키로 바인딩 중이면 끊어집니다.
                  </p>
                )}
              </>
            )}
          </>
        )}

        {node.type === 'if' && (
          <>
            <label style={label}>조건식</label>
            <TokenInput
              ariaLabel="조건식"
              value={node.condition ?? ''}
              onChange={(v) => update(id, { condition: v })}
              sources={sources}
              placeholder="{{ id }} != null — { } 로 데이터 삽입"
            />
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>참이면 T 분기, 거짓이면 F 분기로 진행합니다. (SpEL 안전 평가)</p>
          </>
        )}

        {node.type === 'assert' && (
          <>
            <label style={label}>검증 조건식</label>
            <TokenInput
              ariaLabel="검증 조건식"
              value={node.condition ?? ''}
              onChange={(v) => update(id, { condition: v })}
              sources={sources}
              placeholder="{{ resultCode }} == '0000' — { } 로 데이터 삽입"
            />
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>
              조건이 <b>거짓이면 이 노드가 실패</b>하고 실행이 FAILED 로 끝납니다(테스트 시나리오의 assert).
              두 값 비교도 가능: <code style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{'{{ tid@노티 }} == {{ tid@승인 }}'}</code>
            </p>
          </>
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
                const tr = (transforms.data ?? []).find((t) => t.id === e.target.value)
                update(id, {
                  transformId: e.target.value,
                  config: {},
                  fields: { params: node.fields?.params ?? [], headers: node.fields?.headers ?? [], body: (tr?.inputs ?? []).map((io) => ({ id: newId(), key: io.key, value: '' })) },
                  outputs: (tr?.outputs ?? []).map((o) => ({ key: o.key, type: o.type })),
                })
              }}
            >
              <option value="">선택…</option>
              {(transforms.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
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
                    } catch {
                      /* 업로드 실패 무시(후속: 토스트) */
                    }
                  }
                  e.target.value = ''
                }}
              />
            </label>

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
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 2 }}><label style={label}>호스트</label><input style={mono} value={node.tcpHost ?? ''} onChange={(e) => update(id, { tcpHost: e.target.value })} /></div>
              <div style={{ flex: 1 }}><label style={label}>포트</label><input style={mono} type="number" value={node.tcpPort ?? 0} onChange={(e) => update(id, { tcpPort: Number(e.target.value) })} /></div>
            </div>
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
                <button onClick={() => setPick('rawBody')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }}>{'{ } 데이터 삽입'}</button>
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
            <OutputsEditor outputs={node.outputs ?? []} onChange={(outputs) => update(id, { outputs })} />
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
            <label style={label}>입력 필드 (키 · 라벨 · 타입)</label>
            <WaitFieldsEditor fields={node.waitFields ?? []} onChange={(waitFields) => update(id, { waitFields })} />
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

        <button onClick={() => deleteNode(id)} style={deleteBtn}>이 노드 삭제</button>
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
      {fields.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input style={{ ...mono, flex: 1 }} value={f.key} placeholder="키(=출력)" onChange={(e) => upd(f.id, { key: e.target.value })} />
          <input style={{ ...field, flex: 1 }} value={f.label ?? ''} placeholder="라벨(표시)" onChange={(e) => upd(f.id, { label: e.target.value })} />
          <select style={{ ...field, width: 92 }} value={f.type ?? 'string'} onChange={(e) => upd(f.id, { type: e.target.value })}>
            {['string', 'number', 'boolean', 'json'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...fields, { id: newId(), key: '', label: '', type: 'string' }])} style={addDashed}>+ 입력 필드</button>
    </>
  )
}

/** wait 노드 수신 URL 표시 + 바인딩 토큰 복사. 콜백은 백엔드가 직접 받아 재개한다. */
function WaitReceiveUrl({ nodeId }: { nodeId: string }) {
  const pattern = `{백엔드}/relay/{실행ID}/cb/${nodeId}`
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
        >바인딩 토큰 복사</button>
      </div>
      <p style={{ ...hintP, marginTop: 6 }}>
        실행 시작 시 실행ID가 생성되어 URL 이 확정됩니다(정확한 주소는 실행 로그에 표시). 앞 노드(결제요청의 returnUrl/notiUrl 등)에서
        {'{ }'} 피커의 <b>수신 URL</b> 항목 또는 위 토큰으로 꽂아 쓰세요. 콜백은 <b>백엔드가 직접 받아</b> 실행을 재개합니다.
      </p>
    </>
  )
}

function OutputsEditor({ outputs, onChange }: { outputs: NodeOutput[]; onChange: (o: NodeOutput[]) => void }) {
  const upd = (i: number, patch: Partial<NodeOutput>) => onChange(outputs.map((o, idx) => (idx === i ? { ...o, ...patch } : o)))
  return (
    <>
      {outputs.map((o, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input style={{ ...mono, flex: 1 }} value={o.key} placeholder="키" onChange={(e) => upd(i, { key: e.target.value })} />
          <select style={{ ...field, width: 110 }} value={o.type ?? 'string'} onChange={(e) => upd(i, { type: e.target.value })}>
            {OUTPUT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={() => onChange(outputs.filter((_, idx) => idx !== i))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...outputs, { key: '', type: 'string' }])} style={addDashed}>+ 출력 항목</button>
    </>
  )
}

function VarsEditor({ vars, onChange, sources, sourceType }: { vars: NodeVar[]; onChange: (v: NodeVar[]) => void; sources: BindableSource[]; sourceType: (b: Binding) => string | undefined }) {
  // 시크릿 행은 마스킹(password) 유지가 우선이라 인라인 칩 대신 기존 [값|칩 + { }] 방식을 유지한다.
  const [pickVar, setPickVar] = useState<string | null>(null)
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
                <input style={{ ...mono, flex: 1 }} type="password" value={v.value ?? ''} placeholder="value" onChange={(e) => upd(v.id, { value: e.target.value })} />
                <button onClick={() => setPickVar(v.id)} title="데이터 삽입" style={braceBtn}>{'{ }'}</button>
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


/** TCP 요청 필드 편집기 — 값은 텍스트+토큰 칩 혼합(TokenInput), 토큰화 불가 bound 는 구조적 칩 유지. */
function TcpReqEditor({ fields, sources, sourceType, onChange }: { fields: TcpField[]; sources: BindableSource[]; sourceType: (b: Binding) => string | undefined; onChange: (f: TcpField[]) => void }) {
  const upd = (fid: string, patch: Partial<TcpField>) => onChange(fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)))
  return (
    <>
      {fields.map((f) => (
        <div key={f.id} style={{ border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', padding: 8, marginBottom: 6 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input style={{ ...mono, flex: 2 }} value={f.name ?? ''} placeholder="이름" onChange={(e) => upd(f.id, { name: e.target.value })} />
            <input style={{ ...mono, width: 60 }} type="number" value={f.length ?? 0} title="바이트 길이" onChange={(e) => upd(f.id, { length: Number(e.target.value) })} />
            <select style={{ ...field, width: 56 }} value={f.pad ?? 'right'} title="패딩 방향" onChange={(e) => upd(f.id, { pad: e.target.value as 'left' | 'right' })}>
              <option value="right">→</option>
              <option value="left">←</option>
            </select>
            <input style={{ ...mono, width: 38 }} maxLength={1} value={f.padChar ?? ' '} title="패딩 문자" onChange={(e) => upd(f.id, { padChar: e.target.value })} />
            <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
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
      ))}
      <button onClick={() => onChange([...fields, { id: newId(), name: '', length: 10, value: '', pad: 'right', padChar: ' ' }])} style={addDashed}>+ 요청 필드</button>
    </>
  )
}

function TcpRespEditor({ fields, onChange }: { fields: TcpRespField[]; onChange: (f: TcpRespField[]) => void }) {
  const upd = (fid: string, patch: Partial<TcpRespField>) => onChange(fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)))
  return (
    <>
      {fields.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input style={{ ...mono, flex: 2 }} value={f.name ?? ''} placeholder="이름(=출력 키)" onChange={(e) => upd(f.id, { name: e.target.value })} />
          <input style={{ ...mono, width: 70 }} type="number" value={f.length ?? 0} title="바이트 길이" onChange={(e) => upd(f.id, { length: Number(e.target.value) })} />
          <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...fields, { id: newId(), name: '', length: 10 }])} style={addDashed}>+ 응답 필드</button>
    </>
  )
}

const shell: CSSProperties = { flexShrink: 0, background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', height: '100%' }
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
const deleteBtn: CSSProperties = { marginTop: 28, width: '100%', padding: '9px', border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const addDashed: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
const hintP: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 12, lineHeight: 1.5 }
function tabBtn(active: boolean): CSSProperties {
  return { padding: '7px 12px', border: 'none', borderBottom: `2px solid ${active ? 'var(--fl-primary)' : 'transparent'}`, background: 'transparent', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
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
