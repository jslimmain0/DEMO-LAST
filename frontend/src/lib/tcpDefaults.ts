import type { MockTcpRuleSpec, MockTcpSpec } from '../api/types'
import { newId } from './ids'

/**
 * TCP mock 기본값(순수 — React/axios 의존 없음). MockTcpEditor.tsx 가 re-export.
 * `frontend/src/canvas/nodeFactory.ts` 의 새 TCP 노드 기본값과 바이트 단위로 거울(tcpMirror.mirrorDiff 로 고정)이라
 * "그냥 연결"만 해도 새 TCP Mock 시드와 첫 실행이 성공한다.
 */

/** 새 TCP mock 기본 정의 — 필드 모드 스타터(잔액조회 전문). */
export function defaultTcpSpec(prev?: MockTcpSpec | null): MockTcpSpec {
  const t = prev ?? {}
  return {
    enabled: true, port: t.port ?? 9091, charset: t.charset ?? 'EUC-KR', prefixLength: t.prefixLength ?? 4, prefixIncludesSelf: t.prefixIncludesSelf ?? false,
    requestFields: t.requestFields?.length ? t.requestFields : [{ id: newId(), name: '전문코드', length: 4 }, { id: newId(), name: '계좌번호', length: 10 }],
    rules: t.rules?.length ? t.rules : [defaultTcpRule()],
  }
}
export function defaultTcpRule(): MockTcpRuleSpec {
  return { id: newId(), contains: '', when: [], response: '', responseFields: [
    { id: newId(), name: '응답코드', length: 4, value: '0000', pad: 'right', padChar: ' ' },
    { id: newId(), name: '계좌번호', length: 10, value: '{{req.계좌번호}}', pad: 'right', padChar: ' ' },
    { id: newId(), name: '잔액', length: 12, value: '1500000', pad: 'left', padChar: '0' },
    { id: newId(), name: '고객명', length: 10, value: '홍길동', pad: 'right', padChar: ' ' },
  ] }
}
/** 규칙 한 줄 요약(좌측 목록·개요) — "contains BAL1 · 전문코드 = 0200" / "(기본)". */
export function tcpRuleSummary(r: MockTcpRuleSpec): string {
  const parts: string[] = []
  if (r.contains?.trim()) parts.push(`포함 "${r.contains.trim()}"`)
  for (const c of r.when ?? []) if (c.field) parts.push(`${c.field} ${c.op ?? 'eq'}${c.op === 'exists' ? '' : ` ${c.value ?? ''}`}`)
  return parts.length ? parts.join(' · ') : '조건 없음 (기본)'
}
