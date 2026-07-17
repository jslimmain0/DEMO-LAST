import type { CSSProperties } from 'react'
import { useState } from 'react'
import type { FlowGraph, GraphNode, HttpMethod, PaletteGroup } from '../api/types'
import { useEscapeClose } from '../components/useEscapeClose'
import { makeNode } from '../canvas/nodeFactory'
import { parseCurl } from '../lib/curl'
import { newId } from '../lib/ids'
import { OpenApiImportBody } from './OpenApiImportDialog'
import { WorkflowImportBody } from './WorkflowIODialog'

type Tab = 'workflow' | 'openapi' | 'curl'

/**
 * 통합 가져오기 다이얼로그 — 흩어져 있던 세 진입점(워크플로 JSON·OpenAPI/Swagger·cURL)을 탭 하나로 통합.
 * - 워크플로 JSON: 캔버스 전체 교체
 * - OpenAPI/Swagger: 선택 오퍼레이션을 팔레트 그룹으로 추가
 * - cURL: curl 명령 → HTTP 노드 하나를 캔버스에 추가
 */
export function ImportDialog({
  onImportGraph,
  onImportPalette,
  onImportNode,
  onClose,
  initialTab = 'workflow',
}: {
  onImportGraph: (graph: FlowGraph) => void
  onImportPalette: (group: PaletteGroup) => void
  onImportNode: (template: GraphNode) => void
  onClose: () => void
  initialTab?: Tab
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  useEscapeClose(onClose)

  return (
    <div role="dialog" aria-modal="true" aria-label="가져오기" style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>가져오기</strong>
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            <button onClick={() => setTab('workflow')} style={tabBtn(tab === 'workflow')}>워크플로 JSON</button>
            <button onClick={() => setTab('openapi')} style={tabBtn(tab === 'openapi')}>OpenAPI / Swagger</button>
            <button onClick={() => setTab('curl')} style={tabBtn(tab === 'curl')}>cURL</button>
          </div>
          <button onClick={onClose} aria-label="닫기" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        {tab === 'workflow' && <WorkflowImportBody onImport={onImportGraph} onClose={onClose} />}
        {tab === 'openapi' && <OpenApiImportBody onImport={onImportPalette} onClose={onClose} />}
        {tab === 'curl' && <CurlImportBody onImport={onImportNode} onClose={onClose} />}
      </div>
    </div>
  )
}

/** curl 명령을 파싱해 HTTP 노드 하나를 만들어 캔버스에 추가. (PropertyPanel 의 노드 내 cURL 반영과 같은 매핑) */
function CurlImportBody({ onImport, onClose }: { onImport: (template: GraphNode) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const load = () => {
    setError('')
    const r = parseCurl(text)
    if (!r) { setError('cURL 을 인식하지 못했습니다. `curl https://...` 형식인지 확인하세요.'); return }
    const base = makeNode('http', 0, 0)
    const node: GraphNode = {
      ...base,
      name: `${r.method} 요청`,
      method: r.method as HttpMethod,
      baseUrl: r.url,
      path: '',
      baseUrlBound: null,
      headersRaw: false,
      fields: { params: [], headers: r.headers.map((h) => ({ id: newId(), key: h.key, value: h.value })), body: [] },
    }
    if (r.body) {
      node.bodyType = r.bodyType === 'json' ? 'json' : r.bodyType === 'urlencoded' ? 'urlencoded' : 'raw'
      node.jsonRaw = true
      node.rawBody = r.body
    }
    onImport(node)
    onClose()
  }

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <p style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', margin: '0 0 10px' }}>
        curl 명령을 붙여넣으면 <b>HTTP 노드 하나</b>를 캔버스에 추가합니다 (메서드·URL·헤더·본문 반영).
      </p>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"curl -X POST https://api.example.com/orders \\\n  -H 'Authorization: Bearer T' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"amount\":1000}'"}
        style={{ ...area, flex: 1 }}
      />
      {error && <div style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button onClick={load} disabled={!text.trim()} style={primary}>HTTP 노드 추가</button>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 820, maxWidth: '94vw', height: 'min(680px, 88vh)', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const area: CSSProperties = { width: '100%', resize: 'none', fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)' }
const primary: CSSProperties = { padding: '9px 18px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
function tabBtn(active: boolean): CSSProperties {
  return { padding: '6px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: active ? 'var(--fl-primary)' : 'transparent', color: active ? '#fff' : 'var(--fl-text-muted)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
}
