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
    // 키의 점 경로(customer.name)·배열 인덱스(items[0].sku)를 중첩 구조로 조립 — 요청 json-in-json.
    // 값은 타입별 "리터럴 텍스트"라 실제 객체가 아닌 리터럴 트리를 만들어 직접 직렬화한다.
    const root: PathNode = { kind: 'obj', obj: new Map() }
    for (const r of entries) setPathLiteral(root, r.key.trim(), jsonValueLiteral(r.value ?? '', r.type))
    return serializeTree(root, '')
  }
  return entries.map((r) => `${r.key}=${r.value ?? ''}`).join('&')
}

// 리터럴 트리 — 잎은 이미 직렬화된 JSON 리터럴 텍스트
type PathNode =
  | { kind: 'obj'; obj: Map<string, PathNode> }
  | { kind: 'arr'; arr: Array<PathNode | null> }
  | { kind: 'lit'; lit: string }

function splitPathSegs(key: string): string[] {
  if (!key.includes('.') && !key.includes('[')) return [key]
  return key.replaceAll(']', '').split(/[.[]/).filter((s) => s !== '')
}

function setPathLiteral(root: PathNode & { kind: 'obj' }, key: string, lit: string) {
  const segs = splitPathSegs(key)
  let cur: PathNode = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const nextIsIdx = /^\d+$/.test(segs[i + 1])
    cur = descendLiteral(cur, seg, nextIsIdx) ?? cur
  }
  const last = segs[segs.length - 1]
  if (cur.kind === 'obj') cur.obj.set(last, { kind: 'lit', lit })
  else if (cur.kind === 'arr' && /^\d+$/.test(last)) {
    const idx = Number(last)
    while (cur.arr.length <= idx) cur.arr.push(null)
    cur.arr[idx] = { kind: 'lit', lit }
  }
}

function descendLiteral(cur: PathNode, seg: string, nextIsIdx: boolean): PathNode | null {
  const make = (): PathNode => (nextIsIdx ? { kind: 'arr', arr: [] } : { kind: 'obj', obj: new Map() })
  if (cur.kind === 'obj') {
    const ex = cur.obj.get(seg)
    if (ex && ((nextIsIdx && ex.kind === 'arr') || (!nextIsIdx && ex.kind === 'obj'))) return ex
    const child = make()
    cur.obj.set(seg, child)
    return child
  }
  if (cur.kind === 'arr' && /^\d+$/.test(seg)) {
    const idx = Number(seg)
    while (cur.arr.length <= idx) cur.arr.push(null)
    const ex = cur.arr[idx]
    if (ex && ((nextIsIdx && ex.kind === 'arr') || (!nextIsIdx && ex.kind === 'obj'))) return ex
    const child = make()
    cur.arr[idx] = child
    return child
  }
  return null
}

function serializeTree(n: PathNode, indent: string): string {
  if (n.kind === 'lit') return n.lit
  const pad = indent + '  '
  if (n.kind === 'arr') {
    if (n.arr.length === 0) return '[]'
    const items = n.arr.map((c) => `${pad}${c ? serializeTree(c, pad) : 'null'}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  if (n.obj.size === 0) return '{}'
  const parts = [...n.obj.entries()].map(([k, c]) => `${pad}${JSON.stringify(k)}: ${serializeTree(c, pad)}`)
  return `{\n${parts.join(',\n')}\n${indent}}`
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
    // 중첩 객체는 점 경로 키(customer.name)로 평탄화 — 필드 모드에서 json-in-json 을 행 단위로 편집.
    // 배열은 한 행(array 타입)으로 유지(원소 폭발 방지), 점(.)이 든 실키는 평탄화하지 않고 그대로(경로 오인 방지).
    const rows: KV[] = []
    const push = (k: string, v: unknown) => {
      if (typeof v === 'string') rows.push({ key: k, value: v, type: 'string' })
      else if (typeof v === 'number') rows.push({ key: k, value: String(v), type: 'number' })
      else if (typeof v === 'boolean') rows.push({ key: k, value: String(v), type: 'boolean' })
      else rows.push({ key: k, value: JSON.stringify(v), type: Array.isArray(v) ? 'array' : 'json' }) // array / null
    }
    const walk = (o: Record<string, unknown>, prefix: string, depth: number) => {
      for (const [k, v] of Object.entries(o)) {
        const p = prefix ? `${prefix}.${k}` : k
        const nestable = v !== null && typeof v === 'object' && !Array.isArray(v)
          && Object.keys(v as object).length > 0 && !k.includes('.') && !k.includes('[') && depth < 4
        if (nestable) walk(v as Record<string, unknown>, p, depth + 1)
        else push(p, v)
      }
    }
    walk(obj as Record<string, unknown>, '', 0)
    return rows
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
