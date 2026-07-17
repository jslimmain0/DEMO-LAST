// cURL ↔ HTTP 노드 상호 변환(순수). 붙여넣기로 노드를 채우고, 노드를 curl 로 복사한다.
// 실전 API 도구 관용: -X/--request, -H/--header, -d/--data(-raw/-binary/-urlencode), -G, --url, 흔한 무해 플래그 무시.

export interface ParsedCurl {
  method: string
  url: string
  headers: { key: string; value: string }[]
  body: string
  bodyType: 'json' | 'urlencoded' | 'raw'
}

/** 따옴표(' ")·백슬래시 줄이음을 존중해 토큰으로 쪼갠다. */
function tokenize(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, ' ') // 줄 끝 백슬래시 = 이음
  const out: string[] = []
  let i = 0
  let cur = ''
  let has = false
  while (i < s.length) {
    const c = s[i]
    if (c === "'") {
      has = true
      i++
      while (i < s.length && s[i] !== "'") { cur += s[i]; i++ }
      i++ // 닫는 따옴표
    } else if (c === '"') {
      has = true
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2 } else { cur += s[i]; i++ }
      }
      i++
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (has || cur) { out.push(cur); cur = ''; has = false }
      i++
    } else {
      has = true
      cur += c
      i++
    }
  }
  if (has || cur) out.push(cur)
  return out
}

const IGNORE_FLAGS = new Set(['-s', '--silent', '-L', '--location', '-k', '--insecure', '--compressed', '-i', '--include', '-v', '--verbose', '-#', '--progress-bar', '-f', '--fail'])
const IGNORE_WITH_ARG = new Set(['-o', '--output', '-A', '--user-agent', '-e', '--referer', '--connect-timeout', '-m', '--max-time', '--cacert', '--cert', '--key', '-w', '--write-out'])

/** curl 명령 문자열을 파싱. 실패하면 null(붙여넣기 오인식 방지). */
export function parseCurl(input: string): ParsedCurl | null {
  const text = input.trim()
  if (!/\bcurl\b/i.test(text)) return null
  const toks = tokenize(text)
  const start = toks.findIndex((t) => /^curl$/i.test(t) || /curl(\.exe)?$/i.test(t))
  const args = start >= 0 ? toks.slice(start + 1) : toks
  let method = ''
  let url = ''
  const headers: { key: string; value: string }[] = []
  const dataParts: string[] = []
  let dataUrlencoded = false
  let getMode = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-X' || a === '--request') { method = (args[++i] ?? '').toUpperCase() }
    else if (a === '-H' || a === '--header') {
      const h = args[++i] ?? ''
      const ci = h.indexOf(':')
      if (ci > 0) headers.push({ key: h.slice(0, ci).trim(), value: h.slice(ci + 1).trim() })
    } else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-ascii' || a === '--data-binary') {
      dataParts.push(args[++i] ?? '')
    } else if (a === '--data-urlencode') { dataParts.push(args[++i] ?? ''); dataUrlencoded = true }
    else if (a === '-G' || a === '--get') { getMode = true }
    else if (a === '--url') { url = args[++i] ?? url }
    else if (a === '-u' || a === '--user') {
      const cred = args[++i] ?? ''
      headers.push({ key: 'Authorization', value: 'Basic ' + (typeof btoa === 'function' ? btoa(cred) : cred) })
    } else if (IGNORE_WITH_ARG.has(a)) { i++ }
    else if (IGNORE_FLAGS.has(a)) { /* 무시 */ }
    else if (a.startsWith('-')) { /* 알 수 없는 플래그: 값이 붙었을 수 있으나 무시 */ }
    else if (!url) { url = a }
  }
  if (!url) return null
  const body = dataParts.join('&')
  if (!method) method = body && !getMode ? 'POST' : 'GET'
  // 본문 타입 추정: JSON 이면 json(raw), 아니면 urlencoded(=/& 형태)거나 raw
  let bodyType: ParsedCurl['bodyType'] = 'raw'
  const ct = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value?.toLowerCase() ?? ''
  const trimmed = body.trim()
  if (ct.includes('json') || /^[[{]/.test(trimmed)) bodyType = 'json'
  else if (dataUrlencoded || ct.includes('urlencoded') || (/^[\w.\-%]+=[^&]*(&[\w.\-%]+=[^&]*)*$/.test(trimmed) && trimmed.length > 0)) bodyType = 'urlencoded'
  return { method, url, headers, body, bodyType }
}

/** HTTP 노드 요소를 curl 명령으로. 토큰(`{{ }}`)은 그대로 — 실행 가능한 템플릿 스캐폴드. */
export function toCurl(opts: { method: string; url: string; headers: { key: string; value: string }[]; body?: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const lines = [`curl -X ${opts.method || 'GET'} ${q(opts.url)}`]
  for (const h of opts.headers) if (h.key.trim()) lines.push(`  -H ${q(`${h.key}: ${h.value}`)}`)
  if (opts.body && opts.body.trim()) lines.push(`  --data ${q(opts.body)}`)
  return lines.join(' \\\n')
}
