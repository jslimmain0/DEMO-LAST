import { Background, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CSSProperties, DragEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GraphNode, NodeType } from '../api/types'
import { useEditorStore } from '../store/editorStore'
import { BranchNode } from './BranchNode'
import { DeletableEdge } from './DeletableEdge'
import { NodeCard } from './NodeCard'
import { catColor } from './nodeMeta'

const nodeTypes = { flnode: NodeCard, branch: BranchNode }
const edgeTypes = { deletable: DeletableEdge }
const connectionLineStyle: CSSProperties = { stroke: 'var(--fl-primary)', strokeWidth: 2 }
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
  const flowId = useEditorStore((s) => s.flowId)
  const { screenToFlowPosition, fitBounds } = useReactFlow()

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
    const xs = nodes.map((n) => n.position.x)
    const ys = nodes.map((n) => n.position.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xs)
    const maxY = Math.max(...ys)
    const NODE_W = 230 // 노드 대략 크기(여유 포함) — 측정값 없이 bounds 를 잡기 위한 상수
    const NODE_H = 96
    const rect = { x: minX, y: minY, width: maxX - minX + NODE_W, height: maxY - minY + NODE_H }
    fitBounds(rect, { padding: 0.22, duration: reducedMotion.current ? 0 : 220 })
  }, [nodes, flowId, fitBounds])
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
      style={{ width: '100%', height: '100%' }}
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        onClickConnectStart={() => setConnecting(true)}
        onClickConnectEnd={() => setConnecting(false)}
        connectionRadius={45}
        connectionLineStyle={connectionLineStyle}
        snapToGrid
        snapGrid={[GRID, GRID]}
        onNodeClick={(_, n) => selectNode(n.id)}
        onPaneClick={() => selectNode(null)}
        deleteKeyCode={['Delete', 'Backspace']}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} color="var(--fl-border)" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => catColor((n.data as { cat?: string }).cat)}
          nodeStrokeColor="var(--fl-border)"
          maskColor="color-mix(in srgb, var(--fl-bg) 72%, transparent)"
          bgColor="var(--fl-surface)"
        />
        <Controls />
      </ReactFlow>
    </div>
  )
}
