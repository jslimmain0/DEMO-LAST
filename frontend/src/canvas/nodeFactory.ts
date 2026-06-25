import type { GraphNode, NodeType } from '../api/types'
import { newId } from '../lib/ids'

// 프로토타입 makeNode 의 기본값을 계승. 신규 노드 id 는 [A-Za-z0-9]8 (D5).
export function makeNode(type: NodeType, x: number, y: number): GraphNode {
  const id = newId()
  switch (type) {
    case 'start':
      return { id, name: '시작', type: 'start', cat: 'start', x, y }
    case 'end':
      return { id, name: '끝', type: 'end', cat: 'end', x, y }
    case 'set':
      return {
        id, name: '변수', type: 'set', cat: 'set', x, y,
        vars: [{ id: newId(), key: '', value: '', secret: false }],
      }
    case 'if':
      return { id, name: 'IF 조건', type: 'if', cat: 'if', x, y, condition: '{{ id }} != null' }
    case 'wait':
      return {
        id, name: '입력 대기', type: 'wait', cat: 'wait', x, y,
        waitMsg: '휴대폰으로 받은 OTP를 입력하세요',
        waitFields: [{ id: newId(), key: 'otp', label: 'OTP' }],
      }
    case 'http':
    default:
      return {
        id, name: 'HTTP 요청', type: 'http', cat: 'generic',
        method: 'GET', baseUrl: 'https://api.example.com', path: '/resource',
        bodyType: 'json', respType: 'json', x, y,
        fields: { params: [], headers: [], body: [] },
        outputs: [{ key: 'data', type: 'object' }, { key: 'id', type: 'string' }],
      }
  }
}

export const PALETTE: Array<{ type: NodeType; label: string; cat: string }> = [
  { type: 'start', label: '시작', cat: 'start' },
  { type: 'http', label: 'HTTP 요청', cat: 'generic' },
  { type: 'if', label: 'IF 조건', cat: 'if' },
  { type: 'set', label: '변수', cat: 'set' },
  { type: 'wait', label: '입력 대기', cat: 'wait' },
  { type: 'end', label: '끝', cat: 'end' },
]
