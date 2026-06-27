// 백엔드 그래프 JSON ↔ React Flow 변환 (UI/UX 스펙 §4.2 — 시각 어댑터와 별개의 데이터 어댑터).
import type { Edge, Node } from '@xyflow/react'
import type { FlowGraph, GraphNode } from '../api/types'

export function rfNodeType(domainType: string): string {
  return domainType === 'if' ? 'branch' : 'flnode'
}

export function asGraphNode(data: unknown): GraphNode {
  return data as GraphNode
}

export function toRF(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = (graph.nodes ?? []).map((n) => ({
    id: n.id,
    type: rfNodeType(n.type),
    position: { x: n.x ?? 0, y: n.y ?? 0 },
    data: n as unknown as Record<string, unknown>,
  }))
  const edges: Edge[] = (graph.edges ?? []).map((e) => ({
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
