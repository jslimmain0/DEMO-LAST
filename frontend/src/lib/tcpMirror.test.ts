import { describe, expect, it } from 'vitest'
import type { GraphNode, MockTcpSpec } from '../api/types'
import { alignPatch, mirrorDiff, mockTcpToNode, nodeToMockTcp } from './tcpMirror'

const tcp: MockTcpSpec = { enabled: true, port: 9091, charset: 'EUC-KR', prefixLength: 4, prefixIncludesSelf: false,
  requestFields: [{ id: 'q1', name: '전문코드', length: 4 }, { id: 'q2', name: '계좌번호', length: 10 }],
  rules: [{ id: 't1', contains: '', when: [], response: '', responseFields: [
    { id: 'f1', name: '응답코드', length: 4, value: '0000' }, { id: 'f2', name: '계좌번호', length: 10, value: '{{req.계좌번호}}' },
    { id: 'f3', name: '잔액', length: 12, value: '1500000', pad: 'left', padChar: '0' }, { id: 'f4', name: '고객명', length: 10, value: '홍길동' } ] }] }

describe('tcpMirror', () => {
  it('Mock → 노드: 연결·프리픽스·요청/응답 필드·출력 키', () => {
    const p = mockTcpToNode(tcp, tcp.rules![0], 'localhost')
    expect(p).toMatchObject({ tcpHost: 'localhost', tcpPort: 9091, tcpEncoding: 'EUC-KR', tcpPrefixLength: 4, tcpPrefixIncludesSelf: false })
    expect(p.tcpRequest!.map((f) => [f.name, f.length, f.pad, f.padChar, f.value])).toEqual([['전문코드', 4, 'right', ' ', ''], ['계좌번호', 10, 'right', ' ', '']])
    expect(p.tcpResponse!.map((f) => [f.name, f.length, f.trim, f.type])).toEqual([['응답코드', 4, true, 'string'], ['계좌번호', 10, true, 'string'], ['잔액', 12, true, 'number'], ['고객명', 10, true, 'string']])
    expect(p.outputs).toEqual([{ key: '응답코드', type: 'string' }, { key: '계좌번호', type: 'string' }, { key: '잔액', type: 'number' }, { key: '고객명', type: 'string' }])
  })
  it('노드 → Mock → 노드 왕복(이름·길이 기준) + diff 0', () => {
    const node = { id: 'n', name: 'x', type: 'tcp', cat: 'tcp', x: 0, y: 0, ...mockTcpToNode(tcp, tcp.rules![0], 'localhost') } as GraphNode
    const m = nodeToMockTcp(node)
    expect(m.requestFields!.map((f) => [f.name, f.length])).toEqual([['전문코드', 4], ['계좌번호', 10]])
    expect(m.rules![0].responseFields!.map((f) => [f.name, f.length, f.pad, f.padChar])).toEqual([['응답코드', 4, 'right', ' '], ['계좌번호', 10, 'right', ' '], ['잔액', 12, 'left', '0'], ['고객명', 10, 'right', ' ']])
    expect(mirrorDiff(node, tcp, tcp.rules![0])).toEqual([])
  })
  it('diff: 포트·프리픽스·요청 길이·응답 필드 길이', () => {
    const node = { id: 'n', name: 'x', type: 'tcp', cat: 'tcp', x: 0, y: 0, ...mockTcpToNode(tcp, tcp.rules![0], 'localhost'), tcpPort: 9000, tcpPrefixLength: 0 } as GraphNode
    node.tcpResponse = node.tcpResponse!.map((f, i) => (i === 2 ? { ...f, length: 15 } : f))
    const d = mirrorDiff(node, tcp, tcp.rules![0])
    expect(d.map((x) => x.field)).toEqual(['포트', '프리픽스 길이', '응답 필드 잔액 길이'])
  })
})

describe('alignPatch — 항목별로만 맞춘다(전체 덮어쓰기 아님)', () => {
  const base = () => {
    const n = { id: 'n', name: 'x', type: 'tcp', cat: 'tcp', x: 0, y: 0, ...mockTcpToNode(tcp, tcp.rules![0], 'localhost') } as GraphNode
    // 사용자가 채워 넣은 요청 값(리터럴·토큰) — 맞추기가 절대 건드리면 안 되는 것
    n.tcpRequest = n.tcpRequest!.map((f, i) => (i === 0 ? { ...f, value: '0200' } : { ...f, value: '{{ acct@set1 }}' }))
    return n
  }
  it('연결(포트·인코딩·프리픽스)만 패치하고 요청 값·토큰은 그대로', () => {
    const node = { ...base(), tcpPort: 9000, tcpEncoding: 'UTF-8', tcpPrefixLength: 0, tcpPrefixIncludesSelf: true }
    const { patch, skipped } = alignPatch(node, tcp, tcp.rules![0])
    expect(patch).toEqual({ tcpPort: 9091, tcpEncoding: 'EUC-KR', tcpPrefixLength: 4, tcpPrefixIncludesSelf: false })
    expect(patch.tcpRequest).toBeUndefined()
    expect(patch.tcpResponse).toBeUndefined()
    expect(skipped).toEqual([])
  })
  it('응답 필드 길이는 인덱스로 패치 — 이름·trim·type 유지, 다른 행은 그대로', () => {
    const node = base()
    node.tcpResponse = node.tcpResponse!.map((f, i) => (i === 2 ? { ...f, length: 15 } : f))
    const { patch, skipped } = alignPatch(node, tcp, tcp.rules![0])
    expect(skipped).toEqual([])
    expect(patch.tcpResponse!.map((f) => [f.name, f.length, f.trim, f.type])).toEqual([
      ['응답코드', 4, true, 'string'], ['계좌번호', 10, true, 'string'], ['잔액', 12, true, 'number'], ['고객명', 10, true, 'string'],
    ])
    expect(patch.tcpResponse![0]).toBe(node.tcpResponse![0])   // 같은 행은 참조까지 그대로
    expect(patch.tcpRequest).toBeUndefined()
  })
  it('요청 길이 합·응답 필드 수 차이는 패치하지 않고 skipped 로 보고', () => {
    const node = base()
    node.tcpRequest = [{ id: 'a', name: '전문코드', length: 4, value: '0200', pad: 'right', padChar: ' ' }]
    node.tcpResponse = node.tcpResponse!.slice(0, 2)
    const { patch, skipped } = alignPatch(node, tcp, tcp.rules![0])
    expect(skipped).toEqual(['요청 길이 합', '응답 필드 수'])
    expect(patch).toEqual({})
    expect(node.tcpRequest[0].value).toBe('0200')
  })
})
