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
}
// 현재 일시 토큰 — 백엔드 NowTokens 미러: now | now:패턴 | today | time (+@타임존). 미리보기라 타임존은 KST/UTC/고정 오프셋만 정확(그 외 지역명은 KST 로 근사).
const TIME_RE = /^(now|today|time)(?::(.*?))?(?:@([^@]+))?$/
const ZONE_RE = /^(UTC|GMT|Z|[+-]\d{2}:?\d{2}|[A-Za-z]+\/[A-Za-z_]+)$/i
const isTimeExpr = (inner: string): boolean => { const m = TIME_RE.exec(inner); return !!m && m[2] !== '' && (!m[3] || ZONE_RE.test(m[3])) }

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
  if (inner in BUILTIN || isTimeExpr(inner)) return { raw, id: inner, key: inner, source: null, builtin: true }
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
  if (t.builtin && isTimeExpr(t.id)) return formatNow(t.id)
  if (t.id === 'body') return samples.body ?? '«body»'
  if (t.id === 'req' || t.id.startsWith('req:')) return samples.req ?? '«req»'
  return `«${t.key}»`
}

/** 타임존 → UTC 기준 분 오프셋. KST 기본, UTC/GMT/Z=0, ±hh:mm 고정, 그 외 지역명은 KST 근사(미리보기 용도). */
function zoneOffsetMin(zone: string | undefined): number {
  if (!zone) return 540
  if (/^(UTC|GMT|Z)$/i.test(zone)) return 0
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  return 540
}

/**
 * 현재 일시 토큰 포맷(미리보기) — Java DateTimeFormatter 패턴의 흔한 글자(y M d H h m s S a E)와 '따옴표' 리터럴만 지원.
 * `now`=ISO UTC(백엔드와 동일), `now@타임존`=그 오프셋의 ISO, `today`=yyyyMMdd, `time`=HHmmss.
 */
export function formatNow(expr: string, at: Date = new Date()): string {
  const m = TIME_RE.exec(expr.trim())
  if (!m) return `«${expr}»`
  const [, name, pattern, zone] = m
  const off = zoneOffsetMin(zone)
  const d = new Date(at.getTime() + off * 60_000) // UTC getter 로 읽으면 그 타임존의 벽시계
  const p = pattern || (name === 'today' ? 'yyyyMMdd' : name === 'time' ? 'HHmmss' : '')
  if (!p) {
    if (!zone) return at.toISOString()
    const sign = off < 0 ? '-' : '+'; const a = Math.abs(off)
    return `${fmtPattern("yyyy-MM-dd'T'HH:mm:ss.SSS", d)}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
  }
  return fmtPattern(p, d)
}

function fmtPattern(p: string, d: Date): string {
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  const Y = d.getUTCFullYear(), Mo = d.getUTCMonth() + 1, D = d.getUTCDate(), H = d.getUTCHours(), Mi = d.getUTCMinutes(), S = d.getUTCSeconds(), Ms = d.getUTCMilliseconds(), W = d.getUTCDay()
  const days = ['일', '월', '화', '수', '목', '금', '토']
  let out = ''
  for (let i = 0; i < p.length;) {
    const c = p[i]
    if (c === "'") { // 'literal' ('' = ')
      const j = p.indexOf("'", i + 1)
      if (j === i + 1) { out += "'"; i += 2; continue }
      out += j < 0 ? p.slice(i + 1) : p.slice(i + 1, j); i = j < 0 ? p.length : j + 1; continue
    }
    if (!/[A-Za-z]/.test(c)) { out += c; i++; continue }
    let n = 1; while (p[i + n] === c) n++
    switch (c) {
      case 'y': out += n === 2 ? pad(Y % 100, 2) : pad(Y, n); break
      case 'M': out += n >= 3 ? `${Mo}월` : pad(Mo, n); break
      case 'd': out += pad(D, n); break
      case 'H': out += pad(H, n); break
      case 'h': out += pad(H % 12 || 12, n); break
      case 'm': out += pad(Mi, n); break
      case 's': out += pad(S, n); break
      case 'S': out += pad(Ms, 3).slice(0, n).padEnd(n, '0'); break
      case 'a': out += H < 12 ? '오전' : '오후'; break
      case 'E': out += n >= 4 ? `${days[W]}요일` : days[W]; break
      default: out += c.repeat(n)
    }
    i += n
  }
  return out
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
