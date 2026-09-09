/**
 * 템플릿 미리보기 — 순수. Mock 응답 본문/콜백 응답 같은 템플릿의 `{{ … }}` 토큰을 **샘플 값**으로 치환해 렌더 가능한 문서를 만든다.
 * 두 문법 모두 인식: 칩 문법 `{{ key@source }}` · `{{ key }}` / 기존 dot 문법 `{{body.key}}` `{{req.필드}}` `{{req:o:l}}` / 내장 `{{uuid}} {{seq}} {{now}} {{body}} {{req}}`.
 * 샘플 맵 키는 정규화된 `key@source`(예: `orderId@body`, `id@path`) — 없으면 source 없는 `key` 로도 찾고, 그래도 없으면 `«key»` 로 표시.
 */
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g
const SOURCES = new Set(['body', 'query', 'path', 'header', 'state', 'secret', 'req', 'env', 'input'])
const BUILTIN: Record<string, () => string> = {
  uuid: () => '3f9c2a10-7b4e-4c1d-9e2a-5d8f1c0b7a61',
  seq: () => '1',
  now: () => new Date().toISOString(),
}

export interface TemplateToken {
  raw: string           // 원문 토큰 `{{ orderId@body }}`
  id: string            // 정규화 키 `orderId@body` · `uuid` · `req:0:4`
  key: string           // source 없는 키 `orderId`
  source: string | null // body|query|path|header|state|secret|req|null
  builtin: boolean
}

/** 토큰 하나 정규화. */
export function parseTemplateToken(raw: string): TemplateToken | null {
  const m = /^\{\{\s*([^{}]*?)\s*\}\}$/.exec(raw)
  if (!m) return null
  const inner = m[1].trim()
  if (!inner) return null
  if (inner in BUILTIN) return { raw, id: inner, key: inner, source: null, builtin: true }
  if (inner === 'body' || inner === 'req') return { raw, id: inner, key: inner, source: null, builtin: true }
  if (/^req:\d+:\d+$/.test(inner)) return { raw, id: inner, key: inner, source: 'req', builtin: true }
  const at = inner.lastIndexOf('@')
  if (at > 0) {
    const key = inner.slice(0, at).trim(); const source = inner.slice(at + 1).trim().replace(/^req:/, '')
    return { raw, id: `${key}@${source}`, key, source, builtin: false }
  }
  const dot = inner.indexOf('.')
  if (dot > 0 && SOURCES.has(inner.slice(0, dot))) {
    const source = inner.slice(0, dot); const key = inner.slice(dot + 1)
    return { raw, id: `${key}@${source}`, key, source, builtin: false }
  }
  return { raw, id: inner, key: inner, source: null, builtin: false }
}

/** 문서 안의 토큰(중복 제거, 등장 순). */
export function templateTokens(text: string): TemplateToken[] {
  const seen = new Set<string>()
  const out: TemplateToken[] = []
  for (const m of text.matchAll(TOKEN)) {
    const t = parseTemplateToken(m[0])
    if (!t || seen.has(t.id)) continue
    seen.add(t.id); out.push(t)
  }
  return out
}

/** 샘플 값 조회 — `key@source` → `key` → 내장 → `«key»`. */
export function sampleFor(t: TemplateToken, samples: Record<string, string>): string {
  if (t.id in samples && samples[t.id] !== '') return samples[t.id]
  if (t.key in samples && samples[t.key] !== '') return samples[t.key]
  if (t.id in BUILTIN) return BUILTIN[t.id]()
  if (t.id === 'body') return samples.body ?? '«body»'
  if (t.id === 'req' || t.id.startsWith('req:')) return samples.req ?? '«req»'
  return `«${t.key}»`
}

/** 토큰을 샘플 값으로 치환한 문서. */
export function renderTemplatePreview(text: string, samples: Record<string, string>): string {
  return text.replace(TOKEN, (raw) => { const t = parseTemplateToken(raw); return t ? sampleFor(t, samples) : raw })
}

/** HTML 미리보기에 끼워 넣는 안전망 — 외부로 나가는 링크/폼은 iframe 안에서 열리게(샌드박스라 앱 세션엔 접근 불가). */
export function previewDocument(html: string): string {
  const base = '<base target="_self">'
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${base}`)
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`)
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${html}</body></html>`
}
