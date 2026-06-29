import { Background, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CSSProperties, DragEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { GraphNode, NodeType } from '../api/types'
import { useEditorStore } from '../store/editorStore'
import { BranchNode } from './BranchNode'
import { DeletableEdge } from './DeletableEdge'
import { NodeCard } from './NodeCard'
import { catColor } from './nodeMeta'

const nodeTypes = { flnode: NodeCard, branch: BranchNode }
const edgeTypes = { deletable: DeletableEdge }
const connectionLineStyle: CSSProperties = { stroke: 'var(--fl-primary)', strokeWidth: 2 }

export function FlowCanvas() {
  const nodes = useEditorStore((s) => s.nodes)
  const edges = useEditorStore((s) => s.edges)
  const onNodesChange = useEditorStore((s) => s.onNodesChange)
  const onEdgesChange = useEditorStore((s) => s.onEdgesChange)
  const onConnect = useEditorStore((s) => s.onConnect)
  const selectNode = useEditorStore((s) => s.selectNode)
  const addNode = useEditorStore((s) => s.addNode)
  const addNodeFromTemplate = useEditorStore((s) => s.addNodeFromTemplate)
  const { screenToFlowPosition } = useReactFlow()
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
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
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
        edges={edges}
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
        onNodeClick={(_, n) => selectNode(n.id)}
        onPaneClick={() => selectNode(null)}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} color="var(--fl-border)" />
        <MiniMap pannable zoomable nodeColor={(n) => catColor((n.data as { cat?: string }).cat)} />
        <Controls />
      </ReactFlow>
    </div>
  )
}
