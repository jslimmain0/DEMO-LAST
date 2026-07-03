// 백엔드 그래프 JSON ↔ React Flow 변환 (UI/UX 스펙 §4.2 — 시각 어댑터와 별개의 데이터 어댑터).
import type { Edge, Node } from '@xyflow/react'
import type { FlowGraph, GraphNode } from '../api/types'

export function rfNodeType(domainType: string): string {
  return domainType === 'if' ? 'branch' : 'flnode'
}

export function asGraphNode(data: unknown): GraphNode {
  return data as GraphNode
}

// 레거시 그래프 호환 — 과거에는 type='wait' 하나가 폼 전송(formAction)·입력 대기(waitFields)를 겸했다.
// 백엔드 GraphNode.effectiveType() 과 동일 규칙으로 로드 시 새 타입으로 시프트한다.
function migrateLegacy(n: GraphNode): GraphNode {
  if (n.type !== 'wait') return n
  if (n.formAction && n.formAction.trim() !== '') return { ...n, type: 'form' }
  const hasNewWaitConfig = n.waitTimeoutSec != null || n.cbRespType != null || n.cbRespBody != null
  if (!hasNewWaitConfig && n.waitFields && n.waitFields.length > 0) return { ...n, type: 'input' }
  return n
}

export function toRF(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  // 가져오기(붙여넣기) 등 신뢰할 수 없는 입력도 안전하게 — 배열이 아니면 빈 배열로 방어
  const nodes: Node[] = (Array.isArray(graph.nodes) ? graph.nodes : []).map(migrateLegacy).map((n) => ({
    id: n.id,
    type: rfNodeType(n.type),
    position: { x: n.x ?? 0, y: n.y ?? 0 },
    data: n as unknown as Record<string, unknown>,
  }))
  const edges: Edge[] = (Array.isArray(graph.edges) ? graph.edges : []).map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.fromPort ?? 'out',
    type: 'deletable',
  }))
  return { nodes, edges }
}

export function fromRF(nodes: Node[], edges: Edge[], name: string): FlowGraph {
  return {
    name,
    nodes: nodes.map((n) => {
      const d = asGraphNode(n.data)
      return { ...d, id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }
    }),
    edges: edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      fromPort: e.sourceHandle ?? 'out',
    })),
  }
}
