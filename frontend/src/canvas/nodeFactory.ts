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
    case 'form':
      return {
        id, name: '폼 전송(팝업)', type: 'form', cat: 'form', x, y,
        formAction: '', formMethod: 'POST',
        fields: { params: [], headers: [], body: [{ id: newId(), key: 'returnUrl', value: '' }] },
        outputs: [],
      }
    case 'wait':
      return {
        id, name: '콜백 대기', type: 'wait', cat: 'wait', x, y,
        waitTimeoutSec: 120,
        callbackRespType: 'text',
        callbackRespBody: 'OK',
        outputs: [],
      }
    case 'tcp':
      return {
        id, name: 'TCP 전문', type: 'tcp', cat: 'tcp', x, y,
        tcpHost: '127.0.0.1', tcpPort: 9000, tcpEncoding: 'EUC-KR', tcpTimeoutMs: 5000,
        tcpPrefixLength: 4, tcpPrefixIncludesSelf: false,
        tcpRequest: [{ id: newId(), name: 'msgType', length: 4, value: '', pad: 'right', padChar: ' ' }],
        tcpResponse: [{ id: newId(), name: 'result', length: 10 }],
        outputs: [{ key: 'result', type: 'string' }],
      }
    case 'transform':
      return {
        id, name: '변환', type: 'transform', cat: 'transform', x, y,
        transformId: 'split',
        config: { delimiter: ',', index: '0' },
        fields: { params: [], headers: [], body: [{ id: newId(), key: 'input', value: '' }] },
        outputs: [{ key: 'result', type: 'string' }],
      }
    case 'http':
    default:
      return {
        id, name: 'HTTP 요청', type: 'http', cat: 'generic',
        method: 'GET', baseUrl: 'https://api.example.com', path: '/resource',
        bodyType: 'json', respType: 'json', reqMode: 'server', charset: 'UTF-8', x, y,
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
  { type: 'transform', label: '변환', cat: 'transform' },
  { type: 'tcp', label: 'TCP 전문', cat: 'tcp' },
  { type: 'form', label: '폼 전송(팝업)', cat: 'form' },
  { type: 'wait', label: '콜백 대기', cat: 'wait' },
  { type: 'end', label: '끝', cat: 'end' },
]
