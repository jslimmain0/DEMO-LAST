import type { GraphNode, MockTcpReqField, MockTcpRespField, MockTcpRuleSpec, MockTcpSpec, TcpField, TcpRespField } from '../api/types'
import { newId } from './ids'

/**
 * 노드 ⇄ TCP Mock 거울 변환(순수). 노드 요청 필드 ≅ Mock 요청 레이아웃, 노드 응답 필드 ≅ Mock 규칙 응답 필드.
 * 값 템플릿은 양쪽 의미가 달라 생성 시 비운다(노드 {{ x@n }} 은 Mock 에서 의미 없음, Mock {{req.x}} 는 노드에서 의미 없음).
 */
export function nodeToMockTcp(node: GraphNode, opts?: { port?: number }): MockTcpSpec {
  const requestFields: MockTcpReqField[] = (node.tcpRequest ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, ...(f.encoding ? { encoding: f.encoding } : {}) }))
  const responseFields: MockTcpRespField[] = (node.tcpResponse ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, value: '',
    pad: f.type === 'number' ? 'left' : 'right', padChar: f.type === 'number' ? '0' : ' ', ...(f.encoding ? { encoding: f.encoding } : {}) }))
  const rule: MockTcpRuleSpec = { id: newId(), contains: '', when: [], response: '', responseFields }
  return { enabled: true, port: opts?.port ?? node.tcpPort ?? 9091, charset: node.tcpEncoding ?? 'EUC-KR',
    prefixLength: node.tcpPrefixLength ?? 0, prefixIncludesSelf: !!node.tcpPrefixIncludesSelf, requestFields, rules: [rule] }
}

export function mockTcpToNode(tcp: MockTcpSpec, rule: MockTcpRuleSpec | null, host: string): Partial<GraphNode> {
  const tcpRequest: TcpField[] = (tcp.requestFields ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, value: '', pad: 'right', padChar: ' ', ...(f.encoding ? { encoding: f.encoding } : {}) }))
  const tcpResponse: TcpRespField[] = (rule?.responseFields ?? []).map((f) => ({ id: newId(), name: f.name ?? '', length: f.length ?? 0, trim: true,
    type: f.pad === 'left' && (f.padChar ?? ' ') === '0' ? 'number' : 'string', ...(f.encoding ? { encoding: f.encoding } : {}) }))
  return { tcpHost: host, tcpPort: tcp.port ?? 9091, tcpEncoding: tcp.charset ?? 'EUC-KR', tcpPrefixLength: tcp.prefixLength ?? 4, tcpPrefixIncludesSelf: !!tcp.prefixIncludesSelf,
    tcpRequest, tcpResponse, outputs: tcpResponse.filter((f) => f.name).map((f) => ({ key: f.name!, type: f.type === 'number' ? 'number' : 'string' })) }
}

export interface MirrorDiff { field: string; node: string; mock: string }
export function mirrorDiff(node: GraphNode, tcp: MockTcpSpec, rule: MockTcpRuleSpec | null): MirrorDiff[] {
  const out: MirrorDiff[] = []
  const cmp = (field: string, a: unknown, b: unknown) => { if (String(a ?? '') !== String(b ?? '')) out.push({ field, node: String(a ?? ''), mock: String(b ?? '') }) }
  cmp('포트', node.tcpPort ?? 0, tcp.port ?? 0)
  cmp('인코딩', node.tcpEncoding ?? 'EUC-KR', tcp.charset ?? 'EUC-KR')
  cmp('프리픽스 길이', node.tcpPrefixLength ?? 0, tcp.prefixLength ?? 4)
  cmp('프리픽스 자기 포함', !!node.tcpPrefixIncludesSelf, !!tcp.prefixIncludesSelf)
  const sum = (a: Array<{ length?: number }>) => a.reduce((s, f) => s + (f.length ?? 0), 0)
  cmp('요청 길이 합', sum(node.tcpRequest ?? []), sum(tcp.requestFields ?? []))
  const nr = node.tcpResponse ?? [], mr = rule?.responseFields ?? []
  if (nr.length !== mr.length) out.push({ field: '응답 필드 수', node: String(nr.length), mock: String(mr.length) })
  else nr.forEach((f, i) => cmp(`응답 필드 ${f.name || i + 1} 길이`, f.length ?? 0, mr[i].length ?? 0))
  return out
}

/**
 * [Mock 값으로 맞추기] — **다른 항목만** 골라 패치한다(통째 교체가 아니다).
 * 맞추는 것: 연결(포트·인코딩·프리픽스)과 응답 필드 '길이'(개수가 같을 때 인덱스로).
 * 요청 값·{{ 토큰 }}·바인딩·응답 필드 이름/trim/type·출력 키는 **손대지 않는다**.
 * 표 구조 자체가 다른 항목(요청 길이 합·응답 필드 수)은 patch 하지 않고 `skipped` 로 돌려주고,
 * 호출자가 "[Mock 에서 고르기] 로 통째로 가져오라"고 안내한다(그쪽은 값이 비워지는 전체 가져오기).
 */
export function alignPatch(node: GraphNode, tcp: MockTcpSpec, rule: MockTcpRuleSpec | null): { patch: Partial<GraphNode>; skipped: string[] } {
  const patch: Partial<GraphNode> = {}
  const skipped: string[] = []
  const isRespLen = (field: string) => field.startsWith('응답 필드 ') && field.endsWith(' 길이')
  for (const d of mirrorDiff(node, tcp, rule)) {
    switch (d.field) {
      case '포트': patch.tcpPort = tcp.port ?? node.tcpPort; break
      case '인코딩': patch.tcpEncoding = tcp.charset ?? 'EUC-KR'; break
      case '프리픽스 길이': patch.tcpPrefixLength = tcp.prefixLength ?? 4; break
      case '프리픽스 자기 포함': patch.tcpPrefixIncludesSelf = !!tcp.prefixIncludesSelf; break
      default: if (!isRespLen(d.field)) skipped.push(d.field)   // 요청 길이 합 · 응답 필드 수
    }
  }
  // 응답 필드 길이: 개수가 같을 때만 인덱스로 맞춘다(이름·trim·type 은 그대로 → outputs 도 그대로 유효).
  const nr = node.tcpResponse ?? [], mr = rule?.responseFields ?? []
  if (nr.length === mr.length && nr.some((f, i) => (f.length ?? 0) !== (mr[i].length ?? 0))) {
    patch.tcpResponse = nr.map((f, i) => ((f.length ?? 0) === (mr[i].length ?? 0) ? f : { ...f, length: mr[i].length ?? 0 }))
  }
  return { patch, skipped }
}
