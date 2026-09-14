import { describe, expect, it } from 'vitest'
import type { GraphNode, MockTcpSpec } from '../api/types'
import { mirrorDiff, mockTcpToNode, nodeToMockTcp } from './tcpMirror'

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
