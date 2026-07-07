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

/** targetId 의 모든 조상(상위) 노드를 역방향 BFS 로 수집해 바인딩 항목 목록을 만든다. (모듈 내부 전용) */
function upstreamSources(nodes: Node[], edges: Edge[], targetId: string): BindableSource[] {
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
    if (n.type === 'wait') {
      // 콜백 대기 노드 고정 제공 항목 — 수신 URL(실행 시 시드)과 콜백 원문(body). 선언 outputs 는 위에서 이미 노출.
      if (!items.some((it) => it.key === 'url')) items.push({ key: 'url', type: '수신 URL', scope: null, group: 'response' })
      if (!items.some((it) => it.key === 'body')) items.push({ key: 'body', type: 'string', scope: null, group: 'response' })
    }
    for (const v of n.vars ?? []) if (v.key) items.push({ key: v.key, scope: null, group: 'response' })
    for (const tab of ['params', 'headers', 'body'] as const) {
      for (const f of n.fields?.[tab] ?? []) if (f.key) items.push({ key: f.key, scope: 'req', group: 'request' })
    }
    if (n.waitFields) for (const wf of n.waitFields) if (wf.key) items.push({ key: wf.key, scope: null, group: 'response' })
    // TCP 응답 필드 이름 = 출력 키(outputs 미선언이어도 바인딩 가능하게)
    if (n.type === 'tcp') {
      for (const rf of n.tcpResponse ?? []) {
        if (rf.name && !items.some((it) => it.key === rf.name)) items.push({ key: rf.name, type: 'string', scope: null, group: 'response' })
      }
    }
    if (items.length > 0) {
      sources.push({ id: n.id, name: n.name ?? id, cat: n.cat, type: n.type, items })
    }
  }
  return sources
}

/**
 * 조상 소스에 더해, 그래프의 <b>모든 wait(콜백 대기) 노드의 수신 URL</b> 을 바인딩 소스로 노출한다.
 * 수신 URL 은 실행 시작 시점에 확정(컨텍스트 시드)되므로 wait 보다 앞의 노드에서도 꽂을 수 있다
 * — 결제요청의 returnUrl/notiUrl 에 넣는 표준 패턴.
 */
export function bindableSources(nodes: Node[], edges: Edge[], targetId: string): BindableSource[] {
  const sources = upstreamSources(nodes, edges, targetId)
  const seen = new Set(sources.map((s) => s.id))
  for (const rf of nodes) {
    if (rf.id === targetId || seen.has(rf.id)) continue
    const n = asGraphNode(rf.data)
    if (n.type !== 'wait') continue
    sources.push({
      id: n.id,
      name: `${n.name ?? n.id} (수신 URL)`,
      cat: n.cat,
      type: n.type,
      items: [{ key: 'url', type: '수신 URL', scope: null, group: 'response' }],
    })
  }
  return sources
}
