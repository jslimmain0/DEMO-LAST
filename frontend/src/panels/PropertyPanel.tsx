import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { pluginsApi, transformsApi } from '../api/client'
import type { Binding, BodyType, GraphNode, HttpMethod, NodeField, NodeOutput, NodeVar, RespType, TcpField, TcpRespField, WaitField } from '../api/types'
import { BindingChip } from '../binding/BindingChip'
import { BindingPicker } from '../binding/BindingPicker'
import { upstreamSources } from '../binding/upstream'
import type { BindableSource } from '../binding/upstream'
import { asGraphNode } from '../canvas/graphAdapter'
import { catColor, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { bindingToToken } from '../lib/tokenGrammar'
import { newId } from '../lib/ids'
import { useEditorStore } from '../store/editorStore'
import { KeyValueEditor } from './KeyValueEditor'

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '12px 0 5px' }
const field: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, fontFamily: 'var(--fl-font-ui)' }
const mono: CSSProperties = { ...field, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }
const braceBtn: CSSProperties = { width: 32, height: 32, flexShrink: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer', fontFamily: 'var(--fl-font-mono)', fontSize: 12 }

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const BODY_TYPES: BodyType[] = ['json', 'urlencoded', 'form', 'raw', 'xml']
const RESP_TYPES: RespType[] = ['json', 'text', 'xml', 'binary']
const OUTPUT_TYPES = ['string', 'int', 'number', 'boolean', 'object', 'array', 'secret']

export function PropertyPanel() {
  const selectedId = useEditorStore((s) => s.selectedId)
  const nodes = useEditorStore((s) => s.nodes)
  const edges = useEditorStore((s) => s.edges)
  const update = useEditorStore((s) => s.updateNodeData)
  const selectNode = useEditorStore((s) => s.selectNode)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const [tab, setTab] = useState<'params' | 'headers' | 'body'>('params')
  const [pick, setPick] = useState<string | null>(null) // baseUrl | condition | rawBody | var:<id> | transformInput
  const transforms = useQuery({ queryKey: ['transforms'], queryFn: transformsApi.list })
  const qc = useQueryClient()

  const node = useMemo<GraphNode | null>(() => {
    const n = nodes.find((x) => x.id === selectedId)
    return n ? asGraphNode(n.data) : null
  }, [nodes, selectedId])

  const sources: BindableSource[] = useMemo(
    () => (selectedId ? upstreamSources(nodes, edges, selectedId) : []),
    [nodes, edges, selectedId],
  )

  if (!node) {
    return (
      <aside aria-label="속성" style={shell}>
        <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, padding: 16 }}>노드를 선택하면 속성이 여기에 표시됩니다.</p>
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

  const onPick = (b: Binding) => {
    if (pick === 'baseUrl') update(id, { baseUrlBound: b })
    else if (pick === 'condition') update(id, { condition: `${node.condition ?? ''} ${bindingToToken(b)}`.trim() })
    else if (pick === 'rawBody') update(id, { rawBody: `${node.rawBody ?? ''} ${bindingToToken(b)}`.trim() })
    else if (pick?.startsWith('tinput:')) setInputField(pick.slice(7), { bound: b, value: '' })
    else if (pick?.startsWith('tcpreq:')) {
      const fid = pick.slice(7)
      update(id, { tcpRequest: (node.tcpRequest ?? []).map((f) => (f.id === fid ? { ...f, bound: b, value: '' } : f)) })
    }
    else if (pick?.startsWith('var:')) {
      const vid = pick.slice(4)
      update(id, { vars: (node.vars ?? []).map((v) => (v.id === vid ? { ...v, bound: b, value: '' } : v)) })
    }
    setPick(null)
  }

  return (
    <aside aria-label="속성" style={shell}>
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

            <label style={label}>Base URL</label>
            {node.baseUrlBound ? (
              <BindingChip binding={node.baseUrlBound} sourceType={sourceType(node.baseUrlBound)} onRemove={() => update(id, { baseUrlBound: null })} onClick={() => setPick('baseUrl')} />
            ) : (
              <div style={{ display: 'flex', gap: 4 }}>
                <input style={mono} value={node.baseUrl ?? ''} onChange={(e) => update(id, { baseUrl: e.target.value })} placeholder="https://api.example.com" />
                <button onClick={() => setPick('baseUrl')} title="데이터 삽입" style={braceBtn}>{'{ }'}</button>
              </div>
            )}

            <label style={label}>Path</label>
            <input style={mono} value={node.path ?? ''} onChange={(e) => update(id, { path: e.target.value })} placeholder="/resource" />

            <div style={{ display: 'flex', gap: 4, margin: '16px 0 10px', borderBottom: '1px solid var(--fl-border)' }}>
              {(['params', 'headers', 'body'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>{t === 'params' ? 'Params' : t === 'headers' ? 'Headers' : 'Body'}</button>
              ))}
            </div>

            {tab === 'body' && (
              <div style={{ marginBottom: 10 }}>
                <select style={{ ...field, width: 'auto' }} value={node.bodyType ?? 'json'} onChange={(e) => update(id, { bodyType: e.target.value as BodyType })}>
                  {BODY_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}

            {tab === 'body' && (node.bodyType === 'raw' || node.bodyType === 'xml') ? (
              <div>
                <textarea style={{ ...mono, minHeight: 140, resize: 'vertical' }} value={node.rawBody ?? ''} onChange={(e) => update(id, { rawBody: e.target.value })} placeholder="{ ... } 또는 { } 로 데이터 삽입" />
                <button onClick={() => setPick('rawBody')} style={{ ...braceBtn, width: 'auto', padding: '0 10px', marginTop: 4 }}>{'{ } 데이터 삽입'}</button>
              </div>
            ) : (
              <KeyValueEditor rows={fields[tab] ?? []} onChange={(rows) => setRows(tab, rows)} sources={sources} />
            )}

            <label style={label}>응답 타입</label>
            <select style={field} value={node.respType ?? 'json'} onChange={(e) => update(id, { respType: e.target.value as RespType })}>
              {RESP_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>

            <label style={label}>응답 규격 (출력) — 하위 노드가 바인딩할 항목</label>
            <OutputsEditor outputs={node.outputs ?? []} onChange={(outputs) => update(id, { outputs })} />
          </>
        )}

        {node.type === 'if' && (
          <>
            <label style={label}>조건식</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input style={mono} value={node.condition ?? ''} onChange={(e) => update(id, { condition: e.target.value })} placeholder="{{ id }} != null" />
              <button onClick={() => setPick('condition')} title="데이터 삽입" style={braceBtn}>{'{ }'}</button>
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>참이면 T 분기, 거짓이면 F 분기로 진행합니다. (SpEL 안전 평가)</p>
          </>
        )}

        {node.type === 'set' && (
          <VarsEditor vars={node.vars ?? []} onChange={(vars) => update(id, { vars })} onPickVar={(vid) => setPick(`var:${vid}`)} sourceType={sourceType} />
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
                  {f?.bound ? (
                    <BindingChip binding={f.bound} sourceType={sourceType(f.bound)} onRemove={() => setInputField(io.key, { bound: null })} onClick={() => setPick(`tinput:${io.key}`)} />
                  ) : (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input style={mono} value={f?.value ?? ''} onChange={(e) => setInputField(io.key, { value: e.target.value })} placeholder="값 또는 { } 삽입" />
                      <button onClick={() => setPick(`tinput:${io.key}`)} title="데이터 삽입" style={braceBtn}>{'{ }'}</button>
                    </div>
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
            <TcpReqEditor fields={node.tcpRequest ?? []} sourceType={sourceType} onChange={(r) => update(id, { tcpRequest: r })} onPick={(fid) => setPick(`tcpreq:${fid}`)} />

            <label style={label}>응답 필드 (고정길이 → 출력)</label>
            <TcpRespEditor fields={node.tcpResponse ?? []} onChange={(r) => update(id, { tcpResponse: r })} />
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>응답 필드 이름이 그대로 출력 키가 되어 하위 노드에서 바인딩됩니다.</p>
          </>
        )}

        {node.type === 'wait' && (
          <>
            <label style={label}>안내 메시지</label>
            <input style={field} value={node.waitMsg ?? ''} onChange={(e) => update(id, { waitMsg: e.target.value })} />
            <label style={label}>입력 필드</label>
            <WaitFieldsEditor fields={node.waitFields ?? []} onChange={(waitFields) => update(id, { waitFields })} />
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

function VarsEditor({ vars, onChange, onPickVar, sourceType }: { vars: NodeVar[]; onChange: (v: NodeVar[]) => void; onPickVar: (id: string) => void; sourceType: (b: Binding) => string | undefined }) {
  const upd = (vid: string, patch: Partial<NodeVar>) => onChange(vars.map((v) => (v.id === vid ? { ...v, ...patch } : v)))
  return (
    <>
      <label style={label}>변수</label>
      {vars.map((v) => (
        <div key={v.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={{ ...mono, flex: 1 }} value={v.key} placeholder="key" onChange={(e) => upd(v.id, { key: e.target.value })} />
          {v.bound ? (
            <div style={{ flex: 1 }}><BindingChip binding={v.bound} sourceType={sourceType(v.bound)} onRemove={() => upd(v.id, { bound: null })} onClick={() => onPickVar(v.id)} /></div>
          ) : (
            <>
              <input style={{ ...mono, flex: 1 }} type={v.secret ? 'password' : 'text'} value={v.value ?? ''} placeholder="value" onChange={(e) => upd(v.id, { value: e.target.value })} />
              <button onClick={() => onPickVar(v.id)} title="데이터 삽입" style={braceBtn}>{'{ }'}</button>
            </>
          )}
          <label title="시크릿(마스킹)" style={{ fontSize: 11, color: 'var(--fl-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={!!v.secret} onChange={(e) => upd(v.id, { secret: e.target.checked })} />🔒
          </label>
          <button onClick={() => onChange(vars.filter((x) => x.id !== v.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...vars, { id: newId(), key: '', value: '', secret: false }])} style={addDashed}>+ 변수 추가</button>
    </>
  )
}

function WaitFieldsEditor({ fields, onChange }: { fields: WaitField[]; onChange: (f: WaitField[]) => void }) {
  const upd = (fid: string, patch: Partial<WaitField>) => onChange(fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)))
  return (
    <>
      {fields.map((f) => (
        <div key={f.id} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input style={{ ...mono, flex: 1 }} value={f.key} placeholder="key" onChange={(e) => upd(f.id, { key: e.target.value })} />
          <input style={{ ...field, flex: 1 }} value={f.label ?? ''} placeholder="라벨" onChange={(e) => upd(f.id, { label: e.target.value })} />
          <button onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...fields, { id: newId(), key: '', label: '' }])} style={addDashed}>+ 필드 추가</button>
    </>
  )
}

function TcpReqEditor({ fields, sourceType, onChange, onPick }: { fields: TcpField[]; sourceType: (b: Binding) => string | undefined; onChange: (f: TcpField[]) => void; onPick: (id: string) => void }) {
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
          {f.bound ? (
            <BindingChip binding={f.bound} sourceType={sourceType(f.bound)} onRemove={() => upd(f.id, { bound: null })} onClick={() => onPick(f.id)} />
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              <input style={{ ...mono, flex: 1 }} value={f.value ?? ''} placeholder="값 또는 { } 삽입" onChange={(e) => upd(f.id, { value: e.target.value })} />
              <button onClick={() => onPick(f.id)} title="데이터 삽입" style={braceBtn}>{'{ }'}</button>
            </div>
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

const shell: CSSProperties = { width: 360, borderLeft: '1px solid var(--fl-border)', background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', height: '100%' }
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
const deleteBtn: CSSProperties = { marginTop: 28, width: '100%', padding: '9px', border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const addDashed: CSSProperties = { marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }
function tabBtn(active: boolean): CSSProperties {
  return { padding: '7px 12px', border: 'none', borderBottom: `2px solid ${active ? 'var(--fl-primary)' : 'transparent'}`, background: 'transparent', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
}
