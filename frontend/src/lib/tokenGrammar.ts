// 백엔드 TokenResolver 와 1:1 미러 (D4).
//   {{ key }}            bare (가장 가까운 상위 노드 출력)
//   {{ key@id }}         명시 소스
//   {{ key@req:id }}     요청값 스코프
// key 클래스 [\w.-]+, sourceId 클래스 [\w-]+ (가져온 그래프의 kebab/snake id 호환)
import type { Binding } from '../api/types'

/** 바인딩 → 토큰 문자열(백엔드 chipToken 과 동일 형식). */
export function bindingToToken(b: Pick<Binding, 'key' | 'sourceId' | 'scope'>): string {
  const scope = b.scope === 'req' ? 'req:' : ''
  return `{{ ${b.key}@${scope}${b.sourceId} }}`
}

// 백엔드 TokenResolver.TOKEN 패턴과 동일(그룹: key / req: / sourceId)
const TOKEN_SRC = String.raw`\{\{\s*([\w.-]+)(?:@(req:)?([\w-]+))?\s*\}\}`

/** 토큰 매칭용 정규식(호출마다 새 인스턴스 — lastIndex 공유 버그 방지). */
export function tokenRegex(): RegExp {
  return new RegExp(TOKEN_SRC, 'g')
}

export interface ParsedToken {
  key: string
  scope: 'req' | null
  sourceId: string | null // bare 토큰({{ key }})이면 null
}

/** 단일 토큰 문자열 해석 — 토큰이 아니면 null. */
export function parseToken(raw: string): ParsedToken | null {
  const m = new RegExp(`^${TOKEN_SRC}$`).exec(raw.trim())
  if (!m) return null
  return { key: m[1], scope: m[2] ? 'req' : null, sourceId: m[3] ?? null }
}

export type ValueSegment = { type: 'text'; text: string } | { type: 'token'; raw: string }

/** 문자열을 텍스트/토큰 구간으로 분해 — 인라인 칩 렌더링용. */
export function segmentValue(value: string): ValueSegment[] {
  const out: ValueSegment[] = []
  const re = tokenRegex()
  let last = 0
  for (let m = re.exec(value); m; m = re.exec(value)) {
    if (m.index > last) out.push({ type: 'text', text: value.slice(last, m.index) })
    out.push({ type: 'token', raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', text: value.slice(last) })
  return out
}
