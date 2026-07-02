import type { BodyType } from '../api/types'

// 요청 바디의 [필드 ↔ Raw] 양방향 변환. 순수 함수(런타임 의존성 없음 → 단위 테스트 가능).
// JSON 은 필드 타입(string/number/boolean/json)에 따라 따옴표 여부를 결정해 라운드트립 시 타입을 보존한다.
// 바인딩 토큰 변환·id 부여는 호출부(PropertyPanel)가 담당한다.
export interface KV {
  key: string
  value: string
  type?: string
}

/**
 * 필드(키-값) → Raw 본문 텍스트.
 *  - json: 타입별 직렬화(string→따옴표, number/boolean→그대로, json→내장). 토큰({{…}})은 유효 JSON 위해 문자열로.
 *  - urlencoded/form: {@code key=value&...} (사람이 읽기 쉽게 비인코딩).
 */
export function fieldsToRaw(rows: KV[], bodyType: BodyType): string {
  const entries = (rows ?? []).filter((r) => r.key && r.key.trim() !== '')
  if (bodyType === 'json') {
    if (entries.length === 0) return '{}'
    const parts = entries.map((r) => `  ${JSON.stringify(r.key)}: ${jsonValueLiteral(r.value ?? '', r.type)}`)
    return `{\n${parts.join(',\n')}\n}`
  }
  return entries.map((r) => `${r.key}=${r.value ?? ''}`).join('&')
}

function jsonValueLiteral(value: string, type: string | undefined): string {
  const v = value ?? ''
  if (v.includes('{{')) return JSON.stringify(v) // 토큰(바인딩)은 유효 JSON 유지 위해 따옴표 문자열로
  switch (type) {
    case 'number':
      return v.trim() !== '' && Number.isFinite(Number(v)) ? String(Number(v)) : JSON.stringify(v)
    case 'boolean': {
      const t = v.trim().toLowerCase()
      return t === 'true' || t === 'false' ? t : JSON.stringify(v)
    }
    case 'json':
    case 'array':
      try {
        return JSON.stringify(JSON.parse(v))
      } catch {
        return JSON.stringify(v)
      }
    default: // string/미지정
      return JSON.stringify(v)
  }
}

/**
 * Raw 본문 텍스트 → 필드(키-값). 변환 불가(잘못된 JSON, 객체 아님)면 {@code null}.
 *  - json: 최상위 객체만. 값의 JSON 타입을 추론해 필드 type 으로(문자열/숫자/불리언/json).
 *  - urlencoded/form: {@code &} 로 나누고 첫 {@code =} 로 키/값 분리. 키 trim.
 */
export function rawToFields(raw: string, bodyType: BodyType): KV[] | null {
  const text = (raw ?? '').trim()
  if (bodyType === 'json') {
    if (text === '') return []
    let obj: unknown
    try {
      obj = JSON.parse(text)
    } catch {
      return null
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    return Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
      if (typeof v === 'string') return { key: k, value: v, type: 'string' }
      if (typeof v === 'number') return { key: k, value: String(v), type: 'number' }
      if (typeof v === 'boolean') return { key: k, value: String(v), type: 'boolean' }
      return { key: k, value: JSON.stringify(v), type: Array.isArray(v) ? 'array' : 'json' } // array / object·null
    })
  }
  if (text === '') return []
  return text
    .split('&')
    .filter((p) => p !== '')
    .map((pair) => {
      const i = pair.indexOf('=')
      return {
        key: (i >= 0 ? pair.slice(0, i) : pair).trim(),
        value: i >= 0 ? pair.slice(i + 1) : '',
      }
    })
}

/** 헤더(키-값) → Raw 텍스트: {@code Key: Value} 줄바꿈 목록(curl 붙여넣기 형태). */
export function headersToRaw(rows: KV[]): string {
  return (rows ?? [])
    .filter((r) => r.key && r.key.trim() !== '')
    .map((r) => `${r.key}: ${r.value ?? ''}`)
    .join('\n')
}

/** Raw 텍스트 → 헤더(키-값). 각 줄 첫 {@code :} 로 분리. 콜론 없는 비어있지 않은 줄이 있으면 {@code null}(변환 실패). */
export function rawToHeaders(raw: string): KV[] | null {
  const text = (raw ?? '').trim()
  if (text === '') return []
  const out: KV[] = []
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim()
    if (l === '') continue
    const i = l.indexOf(':')
    if (i < 0) return null
    const key = l.slice(0, i).trim()
    if (key === '') return null
    out.push({ key, value: l.slice(i + 1).trim() })
  }
  return out
}
