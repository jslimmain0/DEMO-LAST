// 선택 노드의 '상위(이전) 노드'들이 제공하는 바인딩 가능 항목(요청/응답 규격)을 계산.
import type { Edge, Node } from '@xyflow/react'
import { asGraphNode } from '../canvas/graphAdapter'

export interface BindableItem {
  key: string
  type?: string
  scope: 'req' | null // null=응답(출력), 'req'=요청값
  group: 'response' | 'request'
}

export interface BindableSource {
  id: string
  name: string
  cat?: string
  type: string
  items: BindableItem[]
}

/** targetId 의 모든 조상(상위) 노드를 역방향 BFS 로 수집해 바인딩 항목 목록을 만든다. */
export function upstreamSources(nodes: Node[], edges: Edge[], targetId: string): BindableSource[] {
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target)!.push(e.source)
  }
  const ancestors: string[] = []
  const seen = new Set<string>()
  const queue = [...(incoming.get(targetId) ?? [])]
  while (queue.length) {
    const id = queue.shift() as string
    if (seen.has(id)) continue
    seen.add(id)
    ancestors.push(id)
    for (const p of incoming.get(id) ?? []) queue.push(p)
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const sources: BindableSource[] = []
  for (const id of ancestors) {
    const rf = byId.get(id)
    if (!rf) continue
    const n = asGraphNode(rf.data)
    const items: BindableItem[] = []
    // HTTP 응답이 통짜형(text/binary)이면 키가 없으므로 본문 전체(body) 한 항목만 노출.
    // 키형(json/xml/form)·기타 노드는 선언된 출력 키를 그대로 노출.
    const rt = n.type === 'http' ? n.respType ?? 'json' : undefined
    if (rt === 'text' || rt === 'binary') {
      items.push({ key: 'body', type: rt === 'binary' ? 'binary' : 'string', scope: null, group: 'response' })
    } else {
      for (const o of n.outputs ?? []) items.push({ key: o.key, type: o.type, scope: null, group: 'response' })
    }
    for (const v of n.vars ?? []) if (v.key) items.push({ key: v.key, scope: null, group: 'response' })
    for (const tab of ['params', 'headers', 'body'] as const) {
      for (const f of n.fields?.[tab] ?? []) if (f.key) items.push({ key: f.key, scope: 'req', group: 'request' })
    }
    if (n.waitFields) for (const wf of n.waitFields) if (wf.key) items.push({ key: wf.key, scope: null, group: 'response' })
    if (items.length > 0) {
      sources.push({ id: n.id, name: n.name ?? id, cat: n.cat, type: n.type, items })
    }
  }
  return sources
}
