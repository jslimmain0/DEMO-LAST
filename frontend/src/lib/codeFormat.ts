/**
 * 코드 정렬(포맷) 도우미 — 순수. 템플릿 토큰 `{{ … }}` 을 자리표시자로 보호한 채 포맷터(js-beautify 등)를 돌리고 복원한다.
 * 포맷터가 `{{ orderId@body }}` 안의 공백/기호를 건드리거나(HTML 속성 값·JSON 문자열 안), JSON 파서가 따옴표 없는 토큰에서
 * 죽는 것을 막는다. 자리표시자는 식별자 모양(`__FLTK3__`)이라 어떤 포맷터도 단어 하나로 취급한다.
 */
const TOKEN = /\{\{[^{}]*\}\}/g
const PLACEHOLDER = /__FLTK(\d+)__/g

export interface Protected {
  text: string
  tokens: string[]
  restore: (s: string) => string
}

export function protectTokens(text: string): Protected {
  const tokens: string[] = []
  const out = text.replace(TOKEN, (m) => { tokens.push(m); return `__FLTK${tokens.length - 1}__` })
  return { text: out, tokens, restore: (s) => s.replace(PLACEHOLDER, (_, i: string) => tokens[Number(i)] ?? _) }
}

/** 토큰을 보호한 채 포맷터 적용. 포맷터가 throw 하면 null(원문 유지). */
export function formatWithTokens(text: string, fmt: (s: string) => string): string | null {
  const p = protectTokens(text)
  try { return p.restore(fmt(p.text)) } catch { return null }
}

/**
 * JSON 정렬 — 토큰을 보호한 뒤 파싱해 2칸 들여쓰기. 따옴표 없는 토큰(`"amount": {{ amount@body }}`)도 자리표시자가
 * 식별자라 파싱은 실패하므로, 그때는 자리표시자를 문자열로 감싸 파싱하고 복원 시 따옴표를 벗긴다.
 */
export function formatJson(text: string): string | null {
  const p = protectTokens(text)
  const pretty = (s: string) => JSON.stringify(JSON.parse(s), null, 2)
  try { return p.restore(pretty(p.text)) } catch { /* 따옴표 없는 토큰 시도 */ }
  try {
    const quoted = p.text.replace(PLACEHOLDER, (m) => `"${m}"`)
    // 이미 문자열 안에 있던 자리표시자는 ""__FLTK0__"" 처럼 이중 따옴표가 되므로 원상 복구
    const fixed = quoted.replace(/""(__FLTK\d+__)""/g, '"$1"')
    const out = pretty(fixed)
    // 우리가 감싼 것만 벗긴다: 원문에서 따옴표 없이 쓰인 토큰 인덱스
    const bare = new Set<number>()
    for (const m of p.text.matchAll(/(^|[^"])__FLTK(\d+)__(?!")/g)) bare.add(Number(m[2]))
    return p.restore(out.replace(/"(__FLTK(\d+)__)"/g, (whole, ph: string, i: string) => (bare.has(Number(i)) ? ph : whole)))
  } catch { return null }
}

export type FormatLang = 'html' | 'json' | 'xml'

/** 언어별 정렬 — html/xml 은 주입된 beautifier(js-beautify html), json 은 내장. 실패(파싱 불가) 시 null. */
export function formatCode(text: string, lang: FormatLang, beautifyHtml: (s: string) => string): string | null {
  if (!text.trim()) return text
  if (lang === 'json') return formatJson(text)
  return formatWithTokens(text, beautifyHtml)
}
