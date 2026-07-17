import type { Edge, Node } from '@xyflow/react'

// 실행은 START 노드에서 시작해 엣지를 따라 흐른다(백엔드 FlowExecutor.initialActive 와 동일 규약).
// START 에서 도달하지 못하는 실행 노드는 실행 시 건너뜀(SKIPPED) — 실행 전에 미리 표시해 혼란을 막는다.
const ANNO = new Set(['note', 'group'])

function nodeType(n: Node): string | undefined {
  return (n.data as { type?: string } | undefined)?.type
}

/** START 노드들에서 엣지를 따라 도달 가능한 노드 id 집합. */
export function reachableFromStart(nodes: Node[], edges: Edge[]): Set<string> {
  const starts = nodes.filter((n) => nodeType(n) === 'start').map((n) => n.id)
  const adj = new Map<string, string[]>()
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, [])
    adj.get(e.source)!.push(e.target)
  }
  const seen = new Set<string>()
  const stack = [...starts]
  while (stack.length) {
    const x = stack.pop()!
    if (seen.has(x)) continue
    seen.add(x)
    for (const t of adj.get(x) ?? []) stack.push(t)
  }
  return seen
}

// nodes/edges 참조가 그대로면 재계산하지 않는 캐시 — 노드마다 selector 로 조회해도 O(N) 유지.
let _cache: { nodes: Node[]; edges: Edge[]; set: Set<string> } | null = null
export function getReachableCached(nodes: Node[], edges: Edge[]): Set<string> {
  if (_cache && _cache.nodes === nodes && _cache.edges === edges) return _cache.set
  const set = reachableFromStart(nodes, edges)
  _cache = { nodes, edges, set }
  return set
}

/** 주석(메모/영역)이 아닌 = 실제 실행되는 노드인가. */
export function isExecutableNode(n: Node): boolean {
  const t = nodeType(n)
  return !!t && !ANNO.has(t)
}

/** START 이 하나라도 있는데 이 노드가 도달 불가한(=실행 시 건너뛰는) 실행 노드인지. */
export function isUnreachableExecutable(node: Node, nodes: Node[], reachable: Set<string>): boolean {
  const t = nodeType(node)
  if (!t || ANNO.has(t) || t === 'start') return false
  if (!nodes.some((n) => nodeType(n) === 'start')) return false // START 자체가 없으면 별도 문제(실행 시 안내)
  return !reachable.has(node.id)
}
