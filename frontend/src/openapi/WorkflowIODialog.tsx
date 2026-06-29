import type { ChangeEvent, CSSProperties } from 'react'
import { useState } from 'react'
import type { FlowGraph } from '../api/types'
import { useEscapeClose } from '../components/useEscapeClose'

// 워크플로(그래프) 전체를 JSON 으로 내보내기/가져오기. 파일 또는 텍스트 붙여넣기 모두 지원.
// 내보내기: 현재 그래프 JSON 을 복사/파일 저장. 가져오기: 파일·붙여넣기 JSON → 캔버스에 로드(교체).
export function WorkflowIODialog({
  getGraph,
  flowName,
  onImport,
  onClose,
  initialTab = 'export',
}: {
  getGraph: () => FlowGraph
  flowName: string
  onImport: (graph: FlowGraph) => void
  onClose: () => void
  initialTab?: 'export' | 'import'
}) {
  const [tab, setTab] = useState<'export' | 'import'>(initialTab)
  useEscapeClose(onClose)
  // 모달은 열 때마다 새로 마운트되므로 매 렌더 계산해도 항상 현재 그래프를 반영(메모이즈 불필요)
  const exportJson = JSON.stringify(getGraph(), null, 2)

  return (
    <div role="dialog" aria-modal="true" aria-label="워크플로 가져오기/내보내기" style={overlay} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>워크플로 JSON</strong>
          <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            <button onClick={() => setTab('export')} style={tabBtn(tab === 'export')}>내보내기</button>
            <button onClick={() => setTab('import')} style={tabBtn(tab === 'import')}>가져오기</button>
          </div>
          <button onClick={onClose} aria-label="닫기" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        {tab === 'export'
          ? <ExportTab json={exportJson} flowName={flowName} />
          : <ImportTab onImport={onImport} onClose={onClose} />}
      </div>
    </div>
  )
}

function ExportTab({ json, flowName }: { json: string; flowName: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)

  const copy = async () => {
    setCopyError(false)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 비보안 컨텍스트(http) 등에서 클립보드 불가 — 직접 선택해 복사하도록 안내
      setCopyError(true)
    }
  }
  const download = () => {
    const safe = (flowName || 'workflow').replace(/[^\w.\-가-힣]+/g, '_')
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${safe}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <p style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', margin: '0 0 10px' }}>현재 캔버스의 워크플로를 JSON 으로 내보냅니다.</p>
      <textarea readOnly value={json} style={{ ...area, flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
        {copyError && <span style={{ fontSize: 11.5, color: 'var(--fl-fail)' }}>클립보드를 쓸 수 없어요. 텍스트를 직접 선택해 복사하세요.</span>}
        <button onClick={copy} style={{ ...ghost, marginLeft: 'auto' }}>{copied ? '복사됨 ✓' : '복사'}</button>
        <button onClick={download} style={primary}>파일 다운로드</button>
      </div>
    </div>
  )
}

function ImportTab({ onImport, onClose }: { onImport: (graph: FlowGraph) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result))
    reader.readAsText(file)
    e.target.value = ''
  }

  const load = () => {
    setError('')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setError('JSON 파싱 실패 — 올바른 워크플로 JSON 인지 확인하세요.')
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      setError('워크플로 JSON(객체)이 아닙니다.')
      return
    }
    const g = parsed as { nodes?: unknown; edges?: unknown }
    if (!Array.isArray(g.nodes)) {
      setError('nodes 배열이 있는 워크플로 JSON 이 아닙니다.')
      return
    }
    if (g.edges != null && !Array.isArray(g.edges)) {
      setError('edges 는 배열이어야 합니다.')
      return
    }
    // 노드 id 가 누락/중복이면 React Flow 키가 깨지므로 사전 검증
    const ids = new Set<string>()
    for (const n of g.nodes) {
      const id = (n as { id?: unknown })?.id
      if (typeof id !== 'string' || !id) {
        setError('각 노드에 문자열 id 가 필요합니다.')
        return
      }
      if (ids.has(id)) {
        setError(`노드 id 가 중복됩니다: ${id}`)
        return
      }
      ids.add(id)
    }
    onImport(parsed as FlowGraph)
    onClose()
  }

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <input type="file" accept=".json,application/json" onChange={onFile} style={{ marginBottom: 10 }} />
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='{ "name": "...", "nodes": [ ... ], "edges": [ ... ] }  (파일 선택 또는 JSON 붙여넣기)'
        style={{ ...area, flex: 1 }}
      />
      {error && <div style={{ color: 'var(--fl-fail)', fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        <span style={{ fontSize: 11.5, color: 'var(--fl-put)' }}>⚠ 현재 캔버스를 대체합니다. (저장 전까지 되돌릴 수 있음)</span>
        <button onClick={load} disabled={!text.trim()} style={primary}>불러오기</button>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 600, maxWidth: '100%', height: 540, maxHeight: '82vh', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const area: CSSProperties = { width: '100%', resize: 'none', fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)' }
const primary: CSSProperties = { padding: '9px 18px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const ghost: CSSProperties = { padding: '9px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer' }
function tabBtn(active: boolean): CSSProperties {
  return { padding: '6px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: active ? 'var(--fl-primary)' : 'transparent', color: active ? '#fff' : 'var(--fl-text-muted)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }
}
