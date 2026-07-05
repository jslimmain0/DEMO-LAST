// 실행 경과(ExecutionDetail 폴링 결과)를 캔버스 표시 상태로 계산한다.
// 노드별 결과가 백엔드에서 노드 단위 짧은 트랜잭션으로 즉시 저장되므로,
// 실행 중 GET /executions/{id} 폴링만으로 "어디까지 왔는지"를 실시간으로 알 수 있다.
import type { Edge, Node } from '@xyflow/react'
import type { ExecutionDetail, NodeExecutionStatus } from '../api/types'

export type NodeRunState = 'running' | 'success' | 'failed' | 'skipped' | 'waiting'
export type EdgeRunState = 'active' | 'done' | 'fail'

export interface RunView {
  nodeStates: Record<string, NodeRunState>
  edgeStates: Record<string, EdgeRunState>
}

const STATUS_MAP: Record<NodeExecutionStatus, NodeRunState> = {
  RUNNING: 'running',
  SUCCEEDED: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  WAITING: 'waiting',
}

/**
 * 캔버스 실행 표시 계산.
 * - 기록된 노드: 성공 ✓ / 실패 ✕ / 건너뜀
 * - 지나간 엣지: done(성공 경로) · fail(실패 노드로 들어간 엣지)
 * - 현재 진행 중(추정) 노드: 백엔드 Kahn 위상정렬을 미러해 "성공한 상위에서 활성화됐지만
 *   아직 기록이 없는 첫 노드" — 그 유입 엣지는 active(움직이는 점선)
 * - pending(client/form/wait/input) 노드는 서버가 알려주므로 정확히 표시
 */
export function computeRunView(
  detail: ExecutionDetail | null,
  running: boolean,
  nodes: Node[],
  edges: Edge[],
): RunView | null {
  if (!detail && !running) return null

  const nodeStates: Record<string, NodeRunState> = {}
  const branch: Record<string, string> = {} // IF 노드가 택한 분기(output.branch)
  if (detail) {
    for (const ne of detail.nodes) {
      nodeStates[ne.nodeId] = STATUS_MAP[ne.status] ?? 'running'
      if (ne.nodeType === 'if' && ne.output && typeof ne.output === 'object') {
        const b = (ne.output as { branch?: unknown }).branch
        if (typeof b === 'string') branch[ne.nodeId] = b
      }
    }
  }

  const pendingId =
    detail?.pendingWait?.nodeId ??
    detail?.pendingClient?.nodeId ??
    detail?.pendingForm?.nodeId ??
    detail?.pendingInput?.nodeId ??
    null
  if (pendingId) nodeStates[pendingId] = detail?.pendingWait ? 'waiting' : 'running'

  // 엣지가 "지나간 경로"인지 — 출발 노드가 성공했고, IF 면 택한 분기와 포트가 일치해야 한다.
  const traversed = (e: Edge): boolean => {
    if (nodeStates[e.source] !== 'success') return false
    const taken = branch[e.source]
    if (taken != null && (e.sourceHandle ?? 'out') !== taken) return false
    return true
  }

  // 진행 중(추정) 노드 — 서버가 pending 을 안 알려주는 동기 실행 구간에서만 추정한다.
  const live = running && (!detail || detail.status === 'RUNNING')
  let currentId: string | null = pendingId
  if (live && !currentId) {
    const active = new Set<string>()
    const hasIncoming = new Set(edges.map((e) => e.target))
    for (const n of nodes) if (!hasIncoming.has(n.id)) active.add(n.id) // 시작(진입차수 0) 노드
    for (const e of edges) if (traversed(e)) active.add(e.target)
    for (const id of topoOrder(nodes, edges)) {
      if (active.has(id) && nodeStates[id] == null) {
        currentId = id
        break
      }
    }
    if (currentId) nodeStates[currentId] = 'running'
  }

  const edgeStates: Record<string, EdgeRunState> = {}
  for (const e of edges) {
    if (!traversed(e)) continue
    const tgt = nodeStates[e.target]
    if (tgt === 'success') edgeStates[e.id] = 'done'
    else if (tgt === 'failed') edgeStates[e.id] = 'fail'
    else if (running && (e.target === currentId || tgt === 'running' || tgt === 'waiting'))
      edgeStates[e.id] = 'active'
  }

  return { nodeStates, edgeStates }
}

// 백엔드 FlowExecutor.topoOrder(Kahn) 미러 — 실행 순서 추정용. 사이클 잔여는 뒤에 덧붙인다.
function topoOrder(nodes: Node[], edges: Edge[]): string[] {
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) {
    indeg.set(n.id, 0)
    adj.set(n.id, [])
  }
  for (const e of edges) {
    if (!adj.has(e.source) || !indeg.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const n of nodes) if (indeg.get(n.id) === 0) queue.push(n.id)
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    for (const t of adj.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 0) - 1)
      if ((indeg.get(t) ?? 0) <= 0) queue.push(t)
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id)
  return order
}
