import type { Edge, Node } from '@xyflow/react'

// 실행은 START 노드에서 시작해 엣지를 따라 흐른다(백엔드 FlowExecutor.initialActive 와 동일 규약).
// START 에서 도달하지 못하는 실행 노드는 실행 시 건너뜀(SKIPPED) — 실행 전에 미리 표시해 혼란을 막는다.
const ANNO = new Set(['note', 'group'])

function nodeType(n: Node): string | undefined {
  return (n.data as { type?: string } | undefined)?.type
}

export interface ReachInfo {
  hasStart: boolean
  reachable: Set<string>
}

/** START 도달성 + START 존재 여부. 주석(메모/영역) 노드는 백엔드가 실행/활성화에서 제외하므로 경로에서도 뺀다. */
export function computeReachInfo(nodes: Node[], edges: Edge[]): ReachInfo {
  const typeById = new Map<string, string | undefined>()
  const starts: string[] = []
  for (const n of nodes) {
    const t = nodeType(n)
    typeById.set(n.id, t)
    if (t === 'start') starts.push(n.id)
  }
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (ANNO.has(typeById.get(e.source) ?? '') || ANNO.has(typeById.get(e.target) ?? '')) continue
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }
  const reachable = new Set<string>()
  const stack = [...starts]
  while (stack.length) {
    const x = stack.pop()!
    if (reachable.has(x)) continue
    reachable.add(x)
    for (const t of adj.get(x) ?? []) stack.push(t)
  }
  return { hasStart: starts.length > 0, reachable }
}

// nodes/edges 참조가 그대로면 재계산하지 않는 캐시 — 노드마다 selector 로 조회해도 O(N) 유지.
let _cache: { nodes: Node[]; edges: Edge[]; info: ReachInfo } | null = null
export function getReachInfoCached(nodes: Node[], edges: Edge[]): ReachInfo {
  if (_cache && _cache.nodes === nodes && _cache.edges === edges) return _cache.info
  const info = computeReachInfo(nodes, edges)
  _cache = { nodes, edges, info }
  return info
}

/** START 이 하나라도 있는데 이 노드가 도달 불가한(=실행 시 건너뛰는) 실행 노드인지. */
export function isUnreachableExecutable(node: Node, info: ReachInfo): boolean {
  const t = nodeType(node)
  if (!t || ANNO.has(t) || t === 'start') return false
  if (!info.hasStart) return false // START 자체가 없으면 별도 문제(실행 시 안내)
  return !info.reachable.has(node.id)
}
