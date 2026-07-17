import { Background, ControlButton, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CSSProperties, DragEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNode, NodeType } from '../api/types'
import { runsApi } from '../api/client'
import { toast } from '../components/toast'
import { useEditorStore } from '../store/editorStore'
import { presence } from '../lib/presence'
import { BranchNode } from './BranchNode'
import { DeletableEdge } from './DeletableEdge'
import { GroupNode } from './GroupNode'
import { NodeAddMenu } from './NodeAddMenu'
import { NodeCard } from './NodeCard'
import { NoteNode } from './NoteNode'
import { PresenceOverlay } from './PresenceOverlay'
import { SwitchNode } from './SwitchNode'
import { catColor } from './nodeMeta'

const nodeTypes = { flnode: NodeCard, branch: BranchNode, switch: SwitchNode, note: NoteNode, annogroup: GroupNode }
const edgeTypes = { deletable: DeletableEdge }
const connectionLineStyle: CSSProperties = { stroke: 'var(--fl-primary)', strokeWidth: 2 }
const alignBtn: CSSProperties = { width: 26, height: 26, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
// 배경 도트(gap 22)와 같은 간격으로 스냅 — 노드가 그리드에 딱딱 맞게 배치된다
const GRID = 22
const snap = (v: number) => Math.round(v / GRID) * GRID

export function FlowCanvas() {
  const nodes = useEditorStore((s) => s.nodes)
  const edges = useEditorStore((s) => s.edges)
  const waitingNodeId = useEditorStore((s) => s.waitingNodeId)
  const runView = useEditorStore((s) => s.runView)
  // 실행 경과 표시 — 지나간 엣지는 색으로, 진행 중인 엣지는 움직이는 점선으로.
  // (콜백 대기 노드 유입 엣지 애니메이션은 runView 가 없어도 waitingNodeId 폴백으로 유지)
  const displayEdges = useMemo(() => {
    if (!runView && !waitingNodeId) return edges
    return edges.map((e) => {
      const st = runView?.edgeStates[e.id]
      if (st === 'active') return { ...e, animated: true, style: { ...e.style, stroke: 'var(--fl-running)', strokeWidth: 2 } }
      if (st === 'done') return { ...e, style: { ...e.style, stroke: 'var(--fl-ok)', strokeWidth: 2 } }
      if (st === 'fail') return { ...e, style: { ...e.style, stroke: 'var(--fl-fail)', strokeWidth: 2 } }
      if (waitingNodeId && e.target === waitingNodeId) return { ...e, animated: true }
      return e
    })
  }, [edges, runView, waitingNodeId])
  const onNodesChange = useEditorStore((s) => s.onNodesChange)
  const onEdgesChange = useEditorStore((s) => s.onEdgesChange)
  const onConnect = useEditorStore((s) => s.onConnect)
  const selectNode = useEditorStore((s) => s.selectNode)
  const addNode = useEditorStore((s) => s.addNode)
  const addNodeFromTemplate = useEditorStore((s) => s.addNodeFromTemplate)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const duplicateSelection = useEditorStore((s) => s.duplicateSelection)
  const updateEdge = useEditorStore((s) => s.updateEdge)
  const alignNodes = useEditorStore((s) => s.alignNodes)
  const distributeNodes = useEditorStore((s) => s.distributeNodes)
  const selectedCount = useEditorStore((s) => s.nodes.reduce((a, n) => a + (n.selected ? 1 : 0), 0))
  const flowId = useEditorStore((s) => s.flowId)
  const focusTick = useEditorStore((s) => s.focusTick)
  const { screenToFlowPosition, fitBounds, zoomTo, setCenter, getZoom } = useReactFlow()
  // 노드 바로가기 — focusNode 신호가 오면 그 노드를 화면 중앙으로(줌 유지, 최소 1)
  useEffect(() => {
    if (focusTick === 0) return
    const { focusId, nodes: ns } = useEditorStore.getState()
    const n = focusId ? ns.find((x) => x.id === focusId) : null
    if (!n) return
    const w = n.measured?.width ?? 230
    const h = n.measured?.height ?? 80
    setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(1, getZoom()), duration: 320 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTick])
  // QoL: 미니맵/그리드 표시 토글(localStorage), 노드 우클릭 컨텍스트 메뉴
  const [showMinimap, setShowMinimap] = useState(() => localStorage.getItem('fl:canvas:minimap') !== '0')
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem('fl:canvas:grid') !== '0')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string; nodeType: string } | null>(null)
  // 빈 캔버스 우클릭/더블클릭·엣지 드래그를 빈 곳에 놓으면 뜨는 노드 추가 메뉴
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; flowPos: { x: number; y: number }; from?: { nodeId: string; handle: string } } | null>(null)
  const openAddMenu = (clientX: number, clientY: number, from?: { nodeId: string; handle: string }) =>
    setAddMenu({ x: clientX, y: clientY, flowPos: screenToFlowPosition({ x: clientX, y: clientY }), from })
  const addFromMenu = (type: NodeType) => {
    if (!addMenu) return
    const newId = addNode(type, addMenu.flowPos)
    if (addMenu.from) onConnect({ source: addMenu.from.nodeId, target: newId, sourceHandle: addMenu.from.handle, targetHandle: null })
    setAddMenu(null)
  }
  // Ctrl/⌘+K — 화면 중앙에 빠른 노드 추가 메뉴
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyK' || e.key === 'k')) {
        e.preventDefault()
        openAddMenu(window.innerWidth / 2, window.innerHeight / 2 - 60)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // openAddMenu 는 안정적인 setter/훅 참조만 사용 — 최초 클로저로 충분
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggleMinimap = () => setShowMinimap((v) => { localStorage.setItem('fl:canvas:minimap', v ? '0' : '1'); return !v })
  const toggleGrid = () => setShowGrid((v) => { localStorage.setItem('fl:canvas:grid', v ? '0' : '1'); return !v })
  const runSingleFromMenu = async (nodeId: string) => {
    if (!flowId) return
    try {
      const r = await runsApi.runNode(flowId, nodeId)
      toast(r.ok ? `이 노드 실행 성공${r.httpStatus != null ? ` · HTTP ${r.httpStatus}` : ''}` : `실행 실패: ${r.responseText ?? ''}`, r.ok ? 'ok' : 'error')
    } catch (e) { toast(`실행 실패: ${e instanceof Error ? e.message : e}`, 'error') }
  }
  const SINGLE_OK = new Set(['http', 'set', 'if', 'switch', 'assert', 'transform', 'tcp'])

  // 정적 fitView prop 은 노드 로드 전(빈 store)에 맞춰져 노드가 좌하단에 몰리는 버그가 있고,
  // fitView 는 측정 완료된 노드만 bounds 에 넣어 초기 로드 시 일부만 맞춘다. 그래서 노드 위치로
  // bounds 를 직접 계산해 fitBounds 로 맞춘다(측정에 비의존 — 로드 즉시 전체 그래프가 정확히 잡힌다).
  const didFit = useRef<string | null>(null)
  const reducedMotion = useRef(false)
  useEffect(() => {
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])
  useEffect(() => {
    if (nodes.length === 0 || didFit.current === flowId) return
    didFit.current = flowId // 플로우 전환 시(이전 노드 잔여 → 새 노드)마다 정확히 1회
    const NODE_W = 230 // 노드 대략 크기(여유 포함) — 측정값 없이 bounds 를 잡기 위한 상수
    const NODE_H = 96
    // 영역 박스는 groupW/groupH 만큼 차지 — bounds 에 실제 크기를 반영한다
    const dims = nodes.map((n) => {
      const d = n.data as { type?: string; groupW?: number; groupH?: number }
      return d.type === 'group' ? { w: d.groupW ?? 396, h: d.groupH ?? 264 } : { w: NODE_W, h: NODE_H }
    })
    const minX = Math.min(...nodes.map((n) => n.position.x))
    const minY = Math.min(...nodes.map((n) => n.position.y))
    const maxX = Math.max(...nodes.map((n, i) => n.position.x + dims[i].w))
    const maxY = Math.max(...nodes.map((n, i) => n.position.y + dims[i].h))
    const rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    fitBounds(rect, { padding: 0.22, duration: reducedMotion.current ? 0 : 220 })
  }, [nodes, flowId, fitBounds])
  // 선택(없으면 전체) 영역을 화면에 꽉 채움 — 큰 서브그래프를 한눈에
  const fitToSelection = useCallback(() => {
    const all = useEditorStore.getState().nodes
    const sel = all.filter((n) => n.selected)
    const target = sel.length ? sel : all
    if (!target.length) return
    const dims = target.map((n) => {
      const d = n.data as { type?: string; groupW?: number; groupH?: number }
      return d.type === 'group' ? { w: d.groupW ?? 396, h: d.groupH ?? 264 } : { w: 230, h: 96 }
    })
    const minX = Math.min(...target.map((n) => n.position.x))
    const minY = Math.min(...target.map((n) => n.position.y))
    const maxX = Math.max(...target.map((n, i) => n.position.x + dims[i].w))
    const maxY = Math.max(...target.map((n, i) => n.position.y + dims[i].h))
    fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { padding: 0.2, duration: reducedMotion.current ? 0 : 220 })
  }, [fitBounds])
  // 연결 중에는 핸들을 키워(자석 타겟) 잡기 쉽게 — CSS .fl-canvas.connecting 으로 제어
  const [connecting, setConnecting] = useState(false)
  // 창 밖에서 포인터를 떼거나 포커스를 잃어 onConnectEnd 가 누락돼도 확대 상태가 고착되지 않도록 복구
  useEffect(() => {
    const reset = () => setConnecting(false)
    window.addEventListener('blur', reset)
    return () => window.removeEventListener('blur', reset)
  }, [])

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      const raw = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const pos = { x: snap(raw.x), y: snap(raw.y) } // 드롭 위치도 그리드에 맞춘다
      const template = e.dataTransfer.getData('application/flowlink-template')
      if (template) {
        try {
          addNodeFromTemplate(JSON.parse(template) as GraphNode, pos)
        } catch {
          /* 잘못된 템플릿 페이로드 무시 */
        }
        return
      }
      const type = e.dataTransfer.getData('application/flowlink-node') as NodeType
      if (!type) return
      addNode(type, pos)
    },
    [screenToFlowPosition, addNode, addNodeFromTemplate],
  )

  return (
    <div
      role="application"
      aria-label="워크플로 캔버스"
      className={connecting ? 'fl-canvas connecting' : 'fl-canvas'}
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onPointerMove={(e) => {
        // presence — 내 커서를 flow 좌표로 다른 참여자에게(쓰로틀은 presence 가)
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        presence.sendCursor(p.x, p.y)
      }}
      onPointerLeave={() => presence.hideCursor()}
    >
      {selectedCount >= 2 && (
        <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 6, display: 'flex', gap: 3, alignItems: 'center', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', boxShadow: 'var(--fl-shadow-lg)', padding: '4px 6px' }}>
          <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', padding: '0 4px' }}>{selectedCount}개 정렬</span>
          {([['left', '⇤', '왼쪽'], ['centerX', '⇔', '가로 가운데'], ['right', '⇥', '오른쪽'], ['top', '⤒', '위'], ['centerY', '⇕', '세로 가운데'], ['bottom', '⤓', '아래']] as const).map(([k, ic, t]) => (
            <button key={k} onClick={() => alignNodes(k)} title={`${t} 정렬`} aria-label={`${t} 정렬`} style={alignBtn}>{ic}</button>
          ))}
          {selectedCount >= 3 && <span style={{ width: 1, height: 16, background: 'var(--fl-border)', margin: '0 2px' }} />}
          {selectedCount >= 3 && <button onClick={() => distributeNodes('x')} title="가로 균등 분배" style={alignBtn}>↔</button>}
          {selectedCount >= 3 && <button onClick={() => distributeNodes('y')} title="세로 균등 분배" style={alignBtn}>↕</button>}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={(oldEdge, newConn) => updateEdge(oldEdge.id, newConn)}
        isValidConnection={(c) => !useEditorStore.getState().edges.some((e) => e.source === c.source && e.target === c.target && (e.sourceHandle ?? 'out') === (c.sourceHandle ?? 'out'))}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={(event, connectionState) => {
          setConnecting(false)
          // 엣지를 노드가 아닌 빈 곳에 놓으면 → 그 위치에 노드 추가 메뉴(고르면 자동 연결)
          if (connectionState.isValid) return
          const from = connectionState.fromNode
          if (!from) return
          const pt = 'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent)
          openAddMenu(pt.clientX, pt.clientY, { nodeId: from.id, handle: connectionState.fromHandle?.id ?? 'out' })
        }}
        onClickConnectStart={() => setConnecting(true)}
        onClickConnectEnd={() => setConnecting(false)}
        connectionRadius={45}
        connectionLineStyle={connectionLineStyle}
        snapToGrid
        snapGrid={[GRID, GRID]}
        disableKeyboardA11y
        onNodeClick={(_, n) => selectNode(n.id)}
        onPaneClick={() => { selectNode(null); setCtxMenu(null); setAddMenu(null) }}
        onNodeContextMenu={(e, n) => { e.preventDefault(); selectNode(n.id); setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: n.id, nodeType: (n.data as { type?: string }).type ?? '' }) }}
        onPaneContextMenu={(e) => { e.preventDefault(); openAddMenu((e as MouseEvent).clientX, (e as MouseEvent).clientY) }}
        onDoubleClick={(e) => { if ((e.target as HTMLElement)?.classList?.contains('react-flow__pane')) openAddMenu(e.clientX, e.clientY) }}
        onMoveStart={() => { setCtxMenu(null); setAddMenu(null) }}
        deleteKeyCode={['Delete', 'Backspace']}
        proOptions={{ hideAttribution: true }}
      >
        {showGrid && <Background gap={22} color="var(--fl-border)" />}
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => catColor((n.data as { cat?: string }).cat)}
            nodeStrokeColor="var(--fl-border)"
            maskColor="color-mix(in srgb, var(--fl-bg) 72%, transparent)"
            bgColor="var(--fl-surface)"
          />
        )}
        <Controls>
          <ControlButton onClick={() => zoomTo(1, { duration: 200 })} title="줌 100%" aria-label="줌 100%"><span style={{ fontSize: 9, fontWeight: 700 }}>1:1</span></ControlButton>
          <ControlButton onClick={fitToSelection} title="선택 영역 맞춤 (없으면 전체)" aria-label="선택 영역 맞춤">⛶</ControlButton>
          <ControlButton onClick={toggleMinimap} title={showMinimap ? '미니맵 숨기기' : '미니맵 보기'} aria-label="미니맵 토글">▣</ControlButton>
          <ControlButton onClick={toggleGrid} title={showGrid ? '그리드 숨기기' : '그리드 보기'} aria-label="그리드 토글">▦</ControlButton>
        </Controls>
        <PresenceOverlay />
      </ReactFlow>
      {ctxMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }} />
          <div style={{ position: 'fixed', left: Math.min(ctxMenu.x, window.innerWidth - 180), top: Math.min(ctxMenu.y, window.innerHeight - 140), zIndex: 41, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', minWidth: 160, padding: 4 }}>
            {SINGLE_OK.has(ctxMenu.nodeType) && (
              <button style={ctxItem} onClick={() => { runSingleFromMenu(ctxMenu.nodeId); setCtxMenu(null) }}>▶ 이 노드만 실행</button>
            )}
            <button style={ctxItem} onClick={() => { duplicateSelection(); setCtxMenu(null) }}>⧉ 복제 (Ctrl+D)</button>
            <button style={{ ...ctxItem, color: 'var(--fl-fail)' }} onClick={() => { deleteNode(ctxMenu.nodeId); setCtxMenu(null) }}>× 삭제 (Delete)</button>
          </div>
        </>
      )}
      {addMenu && (
        <NodeAddMenu x={addMenu.x} y={addMenu.y} onPick={addFromMenu} onClose={() => setAddMenu(null)}
          title={addMenu.from ? '연결할 노드 추가 — 검색' : '노드 추가 — 검색'} />
      )}
    </div>
  )
}

const ctxItem: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5, borderRadius: 6 }
