import type { MockServerSpec } from '../api/types'

/**
 * LLM 이 만든 mock spec 의 얕은 형태 검증 — 적용 전 크래시/편집기 깨짐 방지.
 * 의미(존재하지 않는 {{body.x}} 등)는 저장 시 백엔드 parseSpec + TestPanel 로 확인. 여기선 구조만.
 * @returns 문제 메시지(있으면), 정상이면 null
 */
export function validateMockSpecShape(spec: unknown): string | null {
  if (spec == null || typeof spec !== 'object') return 'spec 이 객체가 아닙니다.'
  const s = spec as MockServerSpec
  if (s.routes != null) {
    if (!Array.isArray(s.routes)) return 'routes 가 배열이 아닙니다.'
    for (const r of s.routes) {
      if (r == null || typeof r !== 'object') return '라우트 항목이 객체가 아닙니다.'
      if (r.rules != null && !Array.isArray(r.rules)) return `라우트 '${r.path ?? '?'}' 의 rules 가 배열이 아닙니다.`
    }
  }
  if (s.tcp != null) {
    if (typeof s.tcp !== 'object') return 'tcp 가 객체가 아닙니다.'
    if (s.tcp.rules != null && !Array.isArray(s.tcp.rules)) return 'tcp.rules 가 배열이 아닙니다.'
  }
  if (s.routes == null && s.tcp == null) return 'routes 도 tcp 도 없습니다(빈 spec).'
  return null
}
