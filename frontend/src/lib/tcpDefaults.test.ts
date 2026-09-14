import { describe, expect, it } from 'vitest'
import { makeNode } from '../canvas/nodeFactory'
import { defaultTcpSpec } from './tcpDefaults'
import { mirrorDiff } from './tcpMirror'

describe('새 TCP 노드 기본값 = 새 TCP Mock 시드', () => {
  it('포트·프리픽스·레이아웃·응답 필드가 일치(diff 0)', () => {
    const node = makeNode('tcp', 0, 0)
    const tcp = defaultTcpSpec()
    expect(mirrorDiff(node, tcp, tcp.rules![0])).toEqual([])
    expect(node.tcpRequest!.map((f) => [f.name, f.value])).toEqual([['전문코드', '0200'], ['계좌번호', '1234567890']])
    expect(node.tcpResponse!.every((f) => f.trim === true)).toBe(true)
    expect(node.outputs).toEqual([{ key: '응답코드', type: 'string' }, { key: '계좌번호', type: 'string' }, { key: '잔액', type: 'number' }, { key: '고객명', type: 'string' }])
  })
})
