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
    case 'assert':
      return { id, name: '검증', type: 'assert', cat: 'assert', x, y, condition: "{{ resultCode }} == '0000'" }
    case 'switch':
      return {
        id, name: '스위치', type: 'switch', cat: 'switch', x, y,
        switchPorts: [{ id: '1', label: '1' }, { id: '2', label: '2' }],
        switchActive: '1',
      }
    case 'form':
      return {
        id, name: '폼 전송(팝업)', type: 'form', cat: 'form', x, y,
        formAction: '', formMethod: 'POST', formDisplay: 'popup',
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
    case 'input':
      return {
        id, name: '사용자 입력', type: 'input', cat: 'input', x, y,
        waitMsg: '휴대폰으로 받은 OTP를 입력하세요',
        waitFields: [{ id: newId(), key: 'otp', label: 'OTP', type: 'string' }],
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
    case 'note':
      return { id, name: '메모', type: 'note', cat: 'note', x, y, noteText: '', noteColor: 'yellow' }
    case 'group':
      // 그리드(22) 배수 기본 크기 — 노드 몇 개를 감싸는 표시용 사각형
      return { id, name: '영역', type: 'group', cat: 'group', x, y, groupW: 396, groupH: 264, noteColor: 'gray' }
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

// group = 팔레트 섹션(클러터 축소). label = 사용자 친화 이름(카드/노드메뉴와 typeLabel 일치).
export const PALETTE: Array<{ type: NodeType; label: string; cat: string; group: string }> = [
  { type: 'start', label: '시작', cat: 'start', group: '기본' },
  { type: 'end', label: '끝', cat: 'end', group: '기본' },
  { type: 'http', label: 'API 호출', cat: 'generic', group: '요청·연동' },
  { type: 'tcp', label: 'TCP 전문', cat: 'tcp', group: '요청·연동' },
  { type: 'if', label: '조건 분기', cat: 'if', group: '흐름 제어' },
  { type: 'switch', label: '경로 전환', cat: 'switch', group: '흐름 제어' },
  { type: 'assert', label: '값 검증', cat: 'assert', group: '흐름 제어' },
  { type: 'set', label: '변수 지정', cat: 'set', group: '데이터' },
  { type: 'transform', label: '데이터 변환', cat: 'transform', group: '데이터' },
  { type: 'form', label: '폼·결제창 열기', cat: 'form', group: '대기·입력' },
  { type: 'wait', label: '콜백 대기', cat: 'wait', group: '대기·입력' },
  { type: 'input', label: '사용자 입력', cat: 'input', group: '대기·입력' },
  { type: 'note', label: '메모', cat: 'note', group: '주석' },
  { type: 'group', label: '영역 박스', cat: 'group', group: '주석' },
]

/** 팔레트 섹션 표시 순서. */
export const PALETTE_GROUPS = ['기본', '요청·연동', '흐름 제어', '데이터', '대기·입력', '주석']
