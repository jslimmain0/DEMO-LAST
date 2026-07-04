// 백엔드 TokenResolver 와 1:1 미러 (D4).
//   {{ key }}            bare (가장 가까운 상위 노드 출력)
//   {{ key@id }}         명시 소스
//   {{ key@req:id }}     요청값 스코프
// key 클래스 [\w.-]+, sourceId 클래스 [A-Za-z0-9]+
import type { Binding } from '../api/types'

/** 바인딩 → 토큰 문자열(백엔드 chipToken 과 동일 형식). */
export function bindingToToken(b: Pick<Binding, 'key' | 'sourceId' | 'scope'>): string {
  const scope = b.scope === 'req' ? 'req:' : ''
  return `{{ ${b.key}@${scope}${b.sourceId} }}`
}
