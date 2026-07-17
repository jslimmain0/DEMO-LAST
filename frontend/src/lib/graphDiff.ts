import type { FlowGraph, GraphEdge, GraphNode } from '../api/types'

/**
 * 두 그래프 버전의 요약 diff — 노드/엣지 id 기준 added/removed/changed.
 * 순수 함수(단위 테스트 가능). 상세 필드 diff 대신 "무엇이 바뀌었나"를 한눈에 보여주는 용도.
 */
export interface GraphDiff {
  nodesAdded: string[]     // 추가된 노드 id
  nodesRemoved: string[]   // 삭제된 노드 id
  nodesChanged: string[]   // 내용이 바뀐 노드 id(위치 제외)
  edgesAdded: number
  edgesRemoved: number
  same: boolean
}

// 위치(x/y)만 다른 건 실질 변경으로 안 침 — 비교에서 좌표 제외
function nodeSig(n: GraphNode): string {
  const clone: Record<string, unknown> = { ...(n as unknown as Record<string, unknown>) }
  delete clone.x
  delete clone.y
  return stableStringify(clone)
}
function edgeKey(e: GraphEdge): string {
  return `${e.from}|${e.fromPort ?? ''}|${e.to}`
}

// 키 정렬 안정 직렬화 — 프로퍼티 순서 차이로 오탐 diff 나지 않게
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function diffGraphs(a: FlowGraph | null | undefined, b: FlowGraph | null | undefined): GraphDiff {
  const an = new Map((a?.nodes ?? []).map((n) => [n.id, n]))
  const bn = new Map((b?.nodes ?? []).map((n) => [n.id, n]))
  const nodesAdded: string[] = []
  const nodesRemoved: string[] = []
  const nodesChanged: string[] = []
  for (const [id, node] of bn) {
    const prev = an.get(id)
    if (!prev) nodesAdded.push(id)
    else if (nodeSig(prev) !== nodeSig(node)) nodesChanged.push(id)
  }
  for (const id of an.keys()) if (!bn.has(id)) nodesRemoved.push(id)

  const ae = new Set((a?.edges ?? []).map(edgeKey))
  const be = new Set((b?.edges ?? []).map(edgeKey))
  let edgesAdded = 0
  let edgesRemoved = 0
  for (const k of be) if (!ae.has(k)) edgesAdded++
  for (const k of ae) if (!be.has(k)) edgesRemoved++

  const same = nodesAdded.length === 0 && nodesRemoved.length === 0 && nodesChanged.length === 0 && edgesAdded === 0 && edgesRemoved === 0
  return { nodesAdded, nodesRemoved, nodesChanged, edgesAdded, edgesRemoved, same }
}

/** diff 를 한국어 요약 문자열로. */
export function diffSummary(d: GraphDiff): string {
  if (d.same) return '변경 없음'
  const parts: string[] = []
  if (d.nodesAdded.length) parts.push(`노드 +${d.nodesAdded.length}`)
  if (d.nodesRemoved.length) parts.push(`노드 −${d.nodesRemoved.length}`)
  if (d.nodesChanged.length) parts.push(`노드 변경 ${d.nodesChanged.length}`)
  if (d.edgesAdded) parts.push(`연결 +${d.edgesAdded}`)
  if (d.edgesRemoved) parts.push(`연결 −${d.edgesRemoved}`)
  return parts.join(' · ')
}
