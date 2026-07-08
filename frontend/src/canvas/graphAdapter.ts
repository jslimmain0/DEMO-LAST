// 백엔드 그래프 JSON ↔ React Flow 변환 (UI/UX 스펙 §4.2 — 시각 어댑터와 별개의 데이터 어댑터).
import type { Edge, Node } from '@xyflow/react'
import type { FlowGraph, GraphNode } from '../api/types'

export function rfNodeType(domainType: string): string {
  if (domainType === 'if') return 'branch'
  if (domainType === 'switch') return 'switch'
  if (domainType === 'note') return 'note'
  if (domainType === 'group') return 'annogroup' // RF 내장 'group'(parent) 타입과 충돌 회피
  return 'flnode'
}

// 타입별 RF 노드 추가 속성 — 영역 박스는 노드들 '뒤'에 깔리고(zIndex), 제목바로만 끌 수 있다.
// (노드 생성 지점 4곳: toRF · addNode · addNodeFromTemplate · pasteClipboard 에서 공용)
export function rfExtras(domainType: string): Partial<Node> {
  if (domainType === 'group') return { zIndex: -1, dragHandle: '.fl-group-drag' }
  return {}
}

export function asGraphNode(data: unknown): GraphNode {
  return data as GraphNode
}

// 하위호환: type=wait 로 저장되던 시기의 그래프 — formAction 이 있으면 폼 전송(form),
// 콜백 설정 없이 waitFields 만 있으면 구 입력 대기(input)로 승격.
// (신규 노드는 form/input/wait 타입을 직접 갖는다. 백엔드 GraphNode.effectiveType() 과 동일 규칙)
function migrateNode(n: GraphNode): GraphNode {
  if (n.type === 'wait') {
    if (n.formAction) return { ...n, type: 'form', cat: 'form' }
    if (n.waitTimeoutSec == null && n.callbackRespType == null && n.callbackRespBody == null
      && (n.waitFields?.length ?? 0) > 0) {
      return { ...n, type: 'input', cat: 'input' }
    }
  }
  return n
}

export function toRF(graph: FlowGraph): { nodes: Node[]; edges: Edge[] } {
  // 가져오기(붙여넣기) 등 신뢰할 수 없는 입력도 안전하게 — 배열이 아니면 빈 배열로 방어
  const nodes: Node[] = (Array.isArray(graph.nodes) ? graph.nodes : []).map(migrateNode).map((n) => ({
    id: n.id,
    type: rfNodeType(n.type),
    position: { x: n.x ?? 0, y: n.y ?? 0 },
    data: n as unknown as Record<string, unknown>,
    ...rfExtras(n.type),
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
