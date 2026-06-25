// 백엔드 TokenResolver.tokenPattern() 과 1:1 미러 (D4).
//   {{ key }}            bare (가장 가까운 상위 노드 출력)
//   {{ key@id }}         명시 소스
//   {{ key@req:id }}     요청값 스코프
// key 클래스 [\w.-]+, sourceId 클래스 [A-Za-z0-9]+
import type { Binding } from '../api/types'

const PATTERN = '\\{\\{\\s*([\\w.-]+)(?:@(req:)?([A-Za-z0-9]+))?\\s*\\}\\}'

/** 매 호출마다 새 정규식(전역 lastIndex 상태 공유 방지). */
export function tokenRegex(): RegExp {
  return new RegExp(PATTERN, 'g')
}

export interface ParsedToken {
  raw: string
  key: string
  req: boolean
  sourceId?: string
  start: number
  end: number
}

export function parseTokens(input: string | null | undefined): ParsedToken[] {
  if (!input) return []
  const re = tokenRegex()
  const out: ParsedToken[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    out.push({
      raw: m[0],
      key: m[1],
      req: m[2] != null,
      sourceId: m[3],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/** 바인딩 → 토큰 문자열(백엔드 chipToken 과 동일 형식). */
export function bindingToToken(b: Pick<Binding, 'key' | 'sourceId' | 'scope'>): string {
  const scope = b.scope === 'req' ? 'req:' : ''
  return `{{ ${b.key}@${scope}${b.sourceId} }}`
}

/** 복사/붙여넣기 시 내부 참조 sourceId 를 새 id 로 치환(외부 참조는 유지). */
export function remapTokenSourceIds(input: string, idMap: Record<string, string>): string {
  return input.replace(tokenRegex(), (raw, key, reqMark: string | undefined, srcId: string | undefined) => {
    if (srcId && idMap[srcId]) {
      return `{{ ${key}@${reqMark ?? ''}${idMap[srcId]} }}`
    }
    return raw
  })
}

export function hasToken(input: string | null | undefined): boolean {
  return !!input && tokenRegex().test(input)
}
