import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import type { BodyType, GraphNode, HttpMethod, NodeField, NodeVar, RespType, WaitField } from '../api/types'
import { asGraphNode } from '../canvas/graphAdapter'
import { catColor, typeIcon, typeLabel } from '../canvas/nodeMeta'
import { newId } from '../lib/ids'
import { useEditorStore } from '../store/editorStore'
import { KeyValueEditor } from './KeyValueEditor'

const label: CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, color: 'var(--fl-text-muted)', margin: '12px 0 5px' }
const field: CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, fontFamily: 'var(--fl-font-ui)' }
const mono: CSSProperties = { ...field, fontFamily: 'var(--fl-font-mono)', fontSize: 12 }

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const BODY_TYPES: BodyType[] = ['json', 'urlencoded', 'form', 'raw', 'xml']
const RESP_TYPES: RespType[] = ['json', 'text', 'xml', 'binary']

export function PropertyPanel() {
  const selectedId = useEditorStore((s) => s.selectedId)
  const nodes = useEditorStore((s) => s.nodes)
  const update = useEditorStore((s) => s.updateNodeData)
  const selectNode = useEditorStore((s) => s.selectNode)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const [tab, setTab] = useState<'params' | 'headers' | 'body'>('params')

  const node = useMemo<GraphNode | null>(() => {
    const n = nodes.find((x) => x.id === selectedId)
    return n ? asGraphNode(n.data) : null
  }, [nodes, selectedId])

  if (!node) {
    return (
      <aside aria-label="속성" style={shell}>
        <p style={{ color: 'var(--fl-text-muted)', fontSize: 13, padding: 16 }}>노드를 선택하면 속성이 여기에 표시됩니다.</p>
      </aside>
    )
  }

  const id = node.id
  const fields = node.fields ?? { params: [], headers: [], body: [] }
  const setRows = (t: 'params' | 'headers' | 'body', rows: NodeField[]) =>
    update(id, { fields: { ...fields, [t]: rows } })

  return (
    <aside aria-label="속성" style={shell}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '14px 16px', borderBottom: '1px solid var(--fl-border)' }}>
        <span aria-hidden style={{ color: catColor(node.cat), fontSize: 16 }}>{typeIcon(node.type)}</span>
        <input
          aria-label="노드 이름"
          value={node.name ?? ''}
          onChange={(e) => update(id, { name: e.target.value })}
          style={{ ...field, fontWeight: 600, fontFamily: 'var(--fl-font-head)' }}
        />
        <button onClick={() => selectNode(null)} aria-label="패널 닫기" style={closeBtn}>×</button>
      </header>

      <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
        <div style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>
          {typeLabel(node.type)} · #{id}
        </div>

        {node.type === 'http' && (
          <>
            <label style={label}>메서드</label>
            <select style={field} value={node.method ?? 'GET'} onChange={(e) => update(id, { method: e.target.value as HttpMethod })}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>

            <label style={label}>Base URL</label>
            <input style={mono} value={node.baseUrl ?? ''} onChange={(e) => update(id, { baseUrl: e.target.value })} placeholder="https://api.example.com" />

            <label style={label}>Path</label>
            <input style={mono} value={node.path ?? ''} onChange={(e) => update(id, { path: e.target.value })} placeholder="/resource" />

            <div style={{ display: 'flex', gap: 4, margin: '16px 0 10px', borderBottom: '1px solid var(--fl-border)' }}>
              {(['params', 'headers', 'body'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
                  {t === 'params' ? 'Params' : t === 'headers' ? 'Headers' : 'Body'}
                </button>
              ))}
            </div>

            {tab === 'body' && (
              <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
                <select style={{ ...field, width: 'auto' }} value={node.bodyType ?? 'json'} onChange={(e) => update(id, { bodyType: e.target.value as BodyType })}>
                  {BODY_TYPES.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            )}

            {tab === 'body' && (node.bodyType === 'raw' || node.bodyType === 'xml') ? (
              <textarea style={{ ...mono, minHeight: 140, resize: 'vertical' }} value={node.rawBody ?? ''} onChange={(e) => update(id, { rawBody: e.target.value })} placeholder="{ ... } 또는 토큰 {{ key@nodeId }}" />
            ) : (
              <KeyValueEditor rows={fields[tab] ?? []} onChange={(rows) => setRows(tab, rows)} />
            )}

            <label style={label}>응답 타입</label>
            <select style={field} value={node.respType ?? 'json'} onChange={(e) => update(id, { respType: e.target.value as RespType })}>
              {RESP_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </>
        )}

        {node.type === 'if' && (
          <>
            <label style={label}>조건식</label>
            <input style={mono} value={node.condition ?? ''} onChange={(e) => update(id, { condition: e.target.value })} placeholder="{{ id@nodeId }} != null" />
            <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>참이면 T 분기, 거짓이면 F 분기로 진행합니다. (SpEL 안전 평가)</p>
          </>
        )}

        {node.type === 'set' && (
          <VarsEditor vars={node.vars ?? []} onChange={(vars) => update(id, { vars })} />
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
    </aside>
  )
}

function VarsEditor({ vars, onChange }: { vars: NodeVar[]; onChange: (v: NodeVar[]) => void }) {
  const upd = (vid: string, patch: Partial<NodeVar>) => onChange(vars.map((v) => (v.id === vid ? { ...v, ...patch } : v)))
  return (
    <>
      <label style={label}>변수</label>
      {vars.map((v) => (
        <div key={v.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <input style={{ ...mono, flex: 1 }} value={v.key} placeholder="key" onChange={(e) => upd(v.id, { key: e.target.value })} />
          <input style={{ ...mono, flex: 1 }} type={v.secret ? 'password' : 'text'} value={v.value ?? ''} placeholder="value" onChange={(e) => upd(v.id, { value: e.target.value })} />
          <label title="시크릿(마스킹)" style={{ fontSize: 11, color: 'var(--fl-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
            <input type="checkbox" checked={!!v.secret} onChange={(e) => upd(v.id, { secret: e.target.checked })} />🔒
          </label>
          <button onClick={() => onChange(vars.filter((x) => x.id !== v.id))} aria-label="삭제" style={{ width: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', cursor: 'pointer' }}>×</button>
        </div>
      ))}
      <button onClick={() => onChange([...vars, { id: newId(), key: '', value: '', secret: false }])} style={{ marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }}>+ 변수 추가</button>
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
      <button onClick={() => onChange([...fields, { id: newId(), key: '', label: '' }])} style={{ marginTop: 2, padding: '6px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 12.5 }}>+ 필드 추가</button>
    </>
  )
}

const shell: CSSProperties = { width: 360, borderLeft: '1px solid var(--fl-border)', background: 'var(--fl-surface)', display: 'flex', flexDirection: 'column', height: '100%' }
const closeBtn: CSSProperties = { width: 30, height: 30, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }
const deleteBtn: CSSProperties = { marginTop: 28, width: '100%', padding: '9px', border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
function tabBtn(active: boolean): CSSProperties {
  return { padding: '7px 12px', border: 'none', borderBottom: `2px solid ${active ? 'var(--fl-primary)' : 'transparent'}`, background: 'transparent', color: active ? 'var(--fl-text)' : 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
}
