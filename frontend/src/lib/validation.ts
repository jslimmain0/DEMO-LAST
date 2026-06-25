// 그래프 공유 순수 검증 (D6). 프론트는 즉시 차단(사이클·dangling 포함),
// 백엔드는 권위(id중복+엣지존재). 사이클/위상은 백엔드 미검증 → 프론트 단독 책임.
import type { FlowGraph } from '../api/types'

export interface ValidationIssue {
  level: 'error' | 'warn'
  code: string
  message: string
  nodeId?: string
}

const MAX_NODES = 200

export function validateGraph(g: FlowGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodes = g.nodes ?? []
  const edges = g.edges ?? []

  if (nodes.length > MAX_NODES) {
    issues.push({ level: 'error', code: 'max_nodes', message: `노드 수가 상한(${MAX_NODES})을 초과했습니다: ${nodes.length}` })
  }

  // 중복 id
  const ids = new Set<string>()
  for (const n of nodes) {
    if (!n.id) {
      issues.push({ level: 'error', code: 'missing_id', message: 'id 없는 노드가 있습니다.' })
      continue
    }
    if (ids.has(n.id)) {
      issues.push({ level: 'error', code: 'dup_id', message: `중복된 노드 id: ${n.id}`, nodeId: n.id })
    }
    ids.add(n.id)
  }

  // 엣지 양끝 존재
  for (const e of edges) {
    if (!e.from || !e.to || !ids.has(e.from) || !ids.has(e.to)) {
      issues.push({ level: 'error', code: 'edge_endpoint', message: `존재하지 않는 노드를 가리키는 엣지: ${e.id}` })
    }
  }

  // 사이클 (백엔드 미검증)
  if (hasCycle(nodes.map((n) => n.id), edges)) {
    issues.push({ level: 'error', code: 'cycle', message: '순환(cycle)이 있습니다 — 실행할 수 없습니다.' })
  }

  return issues
}

function hasCycle(nodeIds: string[], edges: FlowGraph['edges']): boolean {
  const adj = new Map<string, string[]>()
  nodeIds.forEach((id) => adj.set(id, []))
  for (const e of edges ?? []) {
    if (adj.has(e.from)) adj.get(e.from)!.push(e.to)
  }
  const state = new Map<string, 0 | 1 | 2>() // 0=white,1=gray,2=black
  nodeIds.forEach((id) => state.set(id, 0))

  const stack: Array<{ id: string; i: number }> = []
  for (const start of nodeIds) {
    if (state.get(start) !== 0) continue
    stack.push({ id: start, i: 0 })
    state.set(start, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const neighbors = adj.get(top.id) ?? []
      if (top.i < neighbors.length) {
        const next = neighbors[top.i++]
        const st = state.get(next)
        if (st === 1) return true // back edge → cycle
        if (st === 0) {
          state.set(next, 1)
          stack.push({ id: next, i: 0 })
        }
      } else {
        state.set(top.id, 2)
        stack.pop()
      }
    }
  }
  return false
}
