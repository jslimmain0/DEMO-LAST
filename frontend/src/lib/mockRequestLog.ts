import type { MockExpect, MockExpectField, MockRouteSpec } from '../api/types'

/** Mock 요청 기록 → 라우트/예상 요청 도우미(순수). 편집기의 [예상 필드로]·[규칙 초안]이 쓴다. */

/** 경로 패턴 매칭(백엔드 MockRuntime.matchPath 미러) — 요청 기록 → 라우트 찾기. */
export function matchPath(pattern: string | undefined, actual: string): Record<string, string> | null {
  const norm = (p: string) => { let x = (p ?? '').trim(); if (!x.startsWith('/')) x = '/' + x; if (x.length > 1 && x.endsWith('/')) x = x.slice(0, -1); return x }
  if (!pattern?.trim()) return null
  const ps = norm(pattern).split('/'); const ac = norm(actual).split('/')
  if (ps.length !== ac.length) return null
  const out: Record<string, string> = {}
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    if (p.length >= 2 && p.startsWith('{') && p.endsWith('}')) { if (!ac[i]) return null; out[p.slice(1, -1)] = ac[i] }
    else if (p !== ac[i]) return null
  }
  return out
}

/** 요청 기록의 method/path 에 맞는 라우트 인덱스(정의 순서 첫 매칭). */
export function findRouteIndex(routes: MockRouteSpec[], method: string, path: string): number {
  return routes.findIndex((r) => (r.method === 'ANY' || r.method === method) && matchPath(r.path, path) != null)
}

/** 예상 요청 병합 — 기존 키는 유지(예시값 비어 있으면 채움), 새 키는 추가. */
export function mergeExpect(base: MockExpect | null | undefined, add: { body?: Record<string, string>; query?: Record<string, string>; header?: Record<string, string> }): MockExpect {
  const merge = (cur: MockExpectField[] | undefined, src: Record<string, string> | undefined): MockExpectField[] | undefined => {
    if (!src || Object.keys(src).length === 0) return cur
    const out = [...(cur ?? [])]
    for (const [k, v] of Object.entries(src)) {
      const ex = out.find((f) => f.key === k)
      if (ex) { if (!ex.example && v) ex.example = v }
      else out.push({ key: k, example: v })
    }
    return out
  }
  return { body: merge(base?.body, add.body), query: merge(base?.query, add.query), header: merge(base?.header, add.header) }
}

/** 요청 본문 텍스트 → 최상위 키/값(JSON 객체 또는 urlencoded). */
export function bodyKeys(bodyText: string | undefined): Record<string, string> {
  const t = (bodyText ?? '').trim()
  if (!t) return {}
  if (t.startsWith('{')) {
    try { const o = JSON.parse(t) as Record<string, unknown>; const out: Record<string, string> = {}; for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'string' ? v : JSON.stringify(v); return out } catch { /* not json */ }
  }
  if (t.includes('=') && !t.includes('\n')) {
    const out: Record<string, string> = {}
    for (const pair of t.split('&')) { const i = pair.indexOf('='); const k = decodeURIComponent((i >= 0 ? pair.slice(0, i) : pair).replace(/\+/g, ' ')); if (k) out[k] = i >= 0 ? decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' ')) : '' }
    return out
  }
  return {}
}

const STD_HEADERS = new Set(['host', 'content-type', 'content-length', 'user-agent', 'accept', 'accept-encoding', 'accept-language', 'connection', 'origin', 'referer', 'cookie', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'cache-control', 'pragma', 'postman-token', 'accept-charset', 'x-requested-with'])
/** 요청 기록 헤더 중 앱 의미가 있는 것만(표준/브라우저 헤더 제외). */
export function interestingHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) if (!STD_HEADERS.has(k.toLowerCase())) out[k] = v
  return out
}

