import type { Edge, Node } from '@xyflow/react'
import { computeReachInfo } from './reachable'

// 저장·실행 전에 잡을 만한 편집 문제를 한데 모은다 — 미연결(START 미도달) + 필수값 공백.
// PropertyPanel 의 인라인 경고와 같은 기준을 캔버스 전역 요약으로 제공.
export interface FlowIssue {
  nodeId: string
  label: string
  detail: string
  severity: 'warn' | 'error'
}

type NData = {
  type?: string
  name?: string
  baseUrl?: string
  baseUrlBound?: unknown
  condition?: string
  formAction?: string
  transformId?: string
  waitFields?: { key?: string }[]
  tcpHost?: string
}

function d(n: Node): NData {
  return (n.data as NData) ?? {}
}
function blank(s?: string): boolean {
  return !s || !s.trim()
}

export function collectIssues(nodes: Node[], edges: Edge[]): FlowIssue[] {
  const info = computeReachInfo(nodes, edges)
  const out: FlowIssue[] = []
  for (const n of nodes) {
    const nd = d(n)
    const t = nd.type
    if (!t || t === 'note' || t === 'group') continue
    const label = nd.name || t
    // 미연결(실행 시 건너뜀)
    if (info.hasStart && t !== 'start' && !info.reachable.has(n.id)) {
      out.push({ nodeId: n.id, label, detail: '시작(START)에 연결 안 됨 — 실행 시 건너뜀', severity: 'warn' })
    }
    // 필수값 공백
    if (t === 'http' && blank(nd.baseUrl) && !nd.baseUrlBound) out.push({ nodeId: n.id, label, detail: 'URL 이 비어 있음', severity: 'error' })
    else if ((t === 'if' || t === 'assert') && blank(nd.condition)) out.push({ nodeId: n.id, label, detail: '조건식이 비어 있음', severity: 'error' })
    else if (t === 'form' && blank(nd.formAction)) out.push({ nodeId: n.id, label, detail: '열기 URL 이 비어 있음', severity: 'error' })
    else if (t === 'transform' && blank(nd.transformId)) out.push({ nodeId: n.id, label, detail: '변환 미선택', severity: 'error' })
    else if (t === 'input' && (nd.waitFields ?? []).filter((f) => f.key?.trim()).length === 0) out.push({ nodeId: n.id, label, detail: '입력 필드 없음', severity: 'error' })
    else if (t === 'tcp' && blank(nd.tcpHost)) out.push({ nodeId: n.id, label, detail: 'TCP 대상(host) 비어 있음', severity: 'error' })
  }
  // 시작 노드 부재(실행 자체 불가)
  if (!info.hasStart && nodes.some((n) => { const t = d(n).type; return t && t !== 'note' && t !== 'group' })) {
    out.unshift({ nodeId: '', label: '흐름', detail: '시작(START) 노드가 없음 — 실행하려면 필요', severity: 'error' })
  }
  return out
}
