import type { Binding } from '../api/types'
import { fieldsToRaw, headersToRaw, rawToFields } from './bodyConvert'
import { newId } from './ids'
import { bindingToToken, segmentValue } from './tokenGrammar'

/**
 * 텍스트 폼 계약 — 구조화 표(필드 목록) ⇄ 사람이 쓰는 텍스트. 순수(런타임 의존성 0).
 * 규칙: (1) toText 는 항상 성공 (2) fromText 는 절대 throw 하지 않고 실패 줄을 warnings 로 보고(그 줄은 모델에서 빠짐)
 * (3) fromText(toText(rows)) ≡ rows (id 제외, 정규화 기준) 을 각 폼의 테스트가 고정한다
 * (4) prev 는 id 승계(React key·TokenInput 안정)와 bound 복원에 쓴다.
 */
export interface ParseWarning { line: number; text: string; reason: string; /** 그 줄이 모델에서 빠졌는지(true) — 살아남은 줄의 부분 경고는 미설정. */ dropped?: boolean }
export interface TextForm<T> {
  id: string
  label: string
  placeholder: string
  toText(rows: T[]): string
  fromText(text: string, prev: T[]): { rows: T[]; warnings: ParseWarning[] }
}

// ───────────────────────── 고정길이 전문 레이아웃 DSL ─────────────────────────
// 한 줄 = 한 필드:  이름 길이 [종류] [패딩] [인코딩] [= 값]
//   이름   공백/,/|/=/#/" 가 들어가면 "…" 로 감싼다(JSON 문자열 규칙)
//   길이   바이트 정수 | PIC — X(10) 9(12) S9(10)V99 A(3) N(4) ('PIC 9(10)' 처럼 공백으로 띄운 접두도 허용, 길이=합)
//   종류   문자|숫자|한글|영숫자|AN|X|A|C|K|H|N|9|S9   (N/9/S9/숫자 → 좌측 0 패딩·숫자, 그 외 → 우측 공백·문자)
//   원문   (응답 전용) 원문|raw|notrim — 패딩을 떼지 않는다(trim=false). 종류와 같이 써도 되고 단독으로도 된다.
//   패딩   L? | R? — 방향 + 문자 1개('_'=공백, '\,' '\#' '\ ' '\_' '\"' 이스케이프). 종류보다 우선.
//   인코딩 EUC-KR|MS949|UTF-8|US-ASCII
//   값     첫 '=' 이후 줄 끝(양끝 공백 제거). {{ 토큰 }} 그대로. 앞뒤 공백/개행/따옴표가 필요하면 "…"
// 엑셀에서 복사한 TSV/CSV/마크다운 표는 첫 줄이 헤더(항목명/길이/타입/기본값…)면 열 매핑으로 읽는다. 순번 열은 버린다.

export type LayoutMode = 'request' | 'response' | 'layout'
export interface LayoutRow {
  id: string
  name?: string
  length?: number
  value?: string | null
  bound?: Binding | null
  pad?: 'left' | 'right'
  padChar?: string
  encoding?: string
  trim?: boolean
  type?: 'string' | 'number'
}

const ENCODINGS: Record<string, string> = { 'euc-kr': 'EUC-KR', 'ms949': 'MS949', 'utf-8': 'UTF-8', 'utf8': 'UTF-8', 'us-ascii': 'US-ASCII', 'ascii': 'US-ASCII' }
const NUM_KINDS = new Set(['숫자', 'n', '9', 's9', 'num', 'number'])
const CHAR_KINDS = new Set(['문자', '한글', '영숫자', 'an', 'x', 'a', 'c', 'k', 'h', 'char', 'string', 'str'])
/** 응답 모드 전용 속성 — 패딩을 떼지 않음(trim=false). */
const NO_TRIM_KINDS = new Set(['원문', 'raw', 'notrim'])
const HEADER_KEYS = {
  name: ['항목명', '항목', '필드명', '필드', '이름', '명칭', 'name', 'field'],
  length: ['길이', '바이트', 'len', 'length', 'size', 'bytes'],
  type: ['타입', '유형', '형식', '속성', 'type', 'kind'],
  value: ['기본값', '값', '샘플', '예시', 'value', 'default', 'example', 'sample'],
  encoding: ['인코딩', 'encoding', 'charset'],
}
type Kind = 'num' | 'char'
const kindOf = (tok: string): Kind | null => { const t = tok.toLowerCase(); return NUM_KINDS.has(t) ? 'num' : CHAR_KINDS.has(t) ? 'char' : null }

/** PIC/정수 길이 토큰 → {length, kind}. 아니면 null. */
function parseLength(tok: string): { length: number; kind: Kind | null } | null {
  const t = tok.trim()
  if (/^\d+$/.test(t)) return { length: Number(t), kind: null }
  const m = /^(?:PIC\s+)?(S?9|X|A|AN|N)\((\d+)\)(?:V(?:9\((\d+)\)|(9+)))?$/i.exec(t)
  if (!m) return null
  const base = Number(m[2])
  const dec = m[3] ? Number(m[3]) : m[4] ? m[4].length : 0
  const letter = m[1].toUpperCase()
  return { length: base + dec, kind: letter === '9' || letter === 'S9' || letter === 'N' ? 'num' : 'char' }
}

/** 패딩 지정 `L0` `R_` `L\,` → {pad, padChar}. 아니면 null. */
function parsePadSpec(tok: string): { pad: 'left' | 'right'; padChar: string } | null {
  const m = /^([LR])(\\?)(.)$/.exec(tok)
  if (!m) return null
  const ch = m[3] === '_' && !m[2] ? ' ' : m[3]
  return { pad: m[1] === 'L' ? 'left' : 'right', padChar: ch }
}

/** 따옴표를 존중하며 공백/쉼표/파이프/탭으로 토큰 분리. 첫 최상위 '=' 이후는 값(하나의 토큰)으로 돌려준다. */
function tokenize(line: string): { tokens: string[]; value: string | null } {
  const tokens: string[] = []
  let cur = ''
  let inQ = false
  let i = 0
  const push = () => { if (cur !== '') { tokens.push(cur); cur = '' } }
  while (i < line.length) {
    const ch = line[i]
    if (inQ) {
      if (ch === '\\' && i + 1 < line.length) { cur += ch + line[i + 1]; i += 2; continue }
      if (ch === '"') { cur += ch; inQ = false; i++; continue }
      cur += ch; i++; continue
    }
    if (ch === '"') { inQ = true; cur += ch; i++; continue }
    if (ch === '=') { push(); return { tokens, value: line.slice(i + 1).trim() } }
    if (ch === '\\' && i + 1 < line.length) { cur += ch + line[i + 1]; i += 2; continue }
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '|') { push(); i++; continue }
    cur += ch; i++
  }
  push()
  return { tokens, value: null }
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s) } catch { return s.slice(1, -1) } }
  return s
}
function quoteName(name: string): string {
  return name === '' || /[\s,|=#"\\]/.test(name) ? JSON.stringify(name) : name
}
function quoteValue(v: string): string {
  return v !== v.trim() || /[\r\n]/.test(v) || v.startsWith('"') ? JSON.stringify(v) : v
}
function padSpecText(pad: 'left' | 'right', ch: string): string {
  // '_' 는 공백의 표기라 리터럴 '_' 는 반드시 이스케이프. '"' 도 이스케이프해야 토큰화가 따옴표를 열지 않는다(뒤의 '= 값' 유실 방지).
  const c = ch === ' ' ? '_' : /[,|=#\\\s_"]/.test(ch) ? '\\' + ch : ch
  return (pad === 'left' ? 'L' : 'R') + c
}

/** 헤더 줄이면 열 → 역할 매핑, 아니면 null. */
function mapHeader(cells: string[]): Partial<Record<keyof typeof HEADER_KEYS, number>> | null {
  const map: Partial<Record<keyof typeof HEADER_KEYS, number>> = {}
  cells.forEach((c, i) => {
    const t = c.trim().toLowerCase().replace(/[\s()]/g, '')
    for (const k of Object.keys(HEADER_KEYS) as Array<keyof typeof HEADER_KEYS>) {
      if (map[k] === undefined && HEADER_KEYS[k].some((kw) => t === kw || t.startsWith(kw))) { map[k] = i; break }
    }
  })
  return map.name !== undefined && map.length !== undefined ? map : null
}
function splitCells(line: string): string[] {
  if (line.includes('\t')) return line.split('\t')
  if (line.includes('|')) return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')
  if (line.includes(',')) return line.split(',')
  return line.split(/\s{2,}/)
}
/** COBOL 'PIC 9(10)' — 공백으로 끊긴 PIC 접두를 뒤 토큰과 합쳐 하나의 길이 토큰으로. 아니면 그대로. */
function mergePic(toks: string[], at: number): string[] {
  return toks.length > at + 1 && toks[at].toUpperCase() === 'PIC' ? [...toks.slice(0, at), `${toks[at]} ${toks[at + 1]}`, ...toks.slice(at + 2)] : toks
}
const isSepRow = (line: string) => /^\s*\|?(\s*:?-{2,}:?\s*\|?)+\s*$/.test(line)

export function normalizeLayoutRow(r: LayoutRow, mode: LayoutMode): LayoutRow {
  const out: LayoutRow = { id: r.id, name: r.name ?? '', length: r.length ?? 0 }
  if (r.encoding) out.encoding = r.encoding
  if (mode === 'request') {
    out.pad = r.pad ?? 'right'
    out.padChar = (r.padChar ?? ' ').slice(0, 1) || ' '
    if (r.bound) { out.bound = r.bound; out.value = null } else out.value = r.value ?? ''
  } else if (mode === 'response') {
    if (r.type) out.type = r.type
    // type·trim 중 하나라도 정해졌으면 trim 을 boolean 으로 확정 — 레거시 undefined = false(백엔드 규약)이자
    // '원문' 표기가 텍스트 왕복에서 살아남는 근거(fromText(toText(rows)) ≡ rows).
    if (r.type !== undefined || r.trim !== undefined) out.trim = !!r.trim
  }
  return out
}

export function tcpLayoutToText(rows: LayoutRow[], mode: LayoutMode): string {
  return rows.map((raw) => {
    const r = normalizeLayoutRow(raw, mode)
    const parts = [quoteName(r.name ?? ''), String(r.length ?? 0)]
    if (mode === 'request') {
      const pad = r.pad ?? 'right', ch = r.padChar ?? ' '
      if (pad === 'left' && ch === '0') parts.push('숫자')
      else if (pad === 'right' && ch === ' ') parts.push('문자')
      else parts.push(padSpecText(pad, ch))
    } else if (mode === 'response') {
      if (r.type === 'number') parts.push('숫자')
      else if (r.type === 'string' || r.trim) parts.push('문자')
      // 정규화가 type·trim 중 하나라도 있을 때만 trim 을 채우므로, 둘 다 없는 행은 '이름 길이' 로만 나간다.
      if (r.trim === false) parts.push('원문')
    }
    if (r.encoding) parts.push(r.encoding)
    if (mode === 'request') {
      const v = raw.bound ? bindingToToken(raw.bound) : (r.value ?? '')
      if (v !== '') parts.push('= ' + quoteValue(v))
    }
    return parts.join(' ')
  }).join('\n')
}

export function parseTcpLayout(text: string, mode: LayoutMode, prev: LayoutRow[] = []): { rows: LayoutRow[]; warnings: ParseWarning[]; headerMapped: boolean } {
  const rows: LayoutRow[] = []
  const warnings: ParseWarning[] = []
  let header: ReturnType<typeof mapHeader> = null
  let headerMapped = false
  const lines = (text ?? '').split(/\r?\n/)
  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || isSepRow(line)) return
    let draft: { name: string; length: number; kind: Kind | null; noTrim?: boolean; padSpec: ReturnType<typeof parsePadSpec>; encoding?: string; value: string | null } | null = null
    if (header) {
      const cells = splitCells(rawLine).map((c) => c.trim())
      const len = parseLength(cells[header.length!] ?? '')
      const name = unquote(cells[header.name!] ?? '')
      if (!len || name === '') { warnings.push({ line: lineNo, text: rawLine, reason: '이름 또는 길이 열을 읽을 수 없음', dropped: true }); return }
      const typeTok = header.type !== undefined ? (cells[header.type] ?? '') : ''
      draft = { name, length: len.length, kind: (typeTok && kindOf(typeTok)) || len.kind, padSpec: null,
        encoding: header.encoding !== undefined ? ENCODINGS[(cells[header.encoding] ?? '').toLowerCase()] : undefined,
        value: header.value !== undefined ? unquote(cells[header.value] ?? '') : null }
    } else {
      const { tokens, value } = tokenize(line)
      // 'PIC 9(10)' 처럼 공백으로 끊긴 길이 토큰을 먼저 합친다 — 이름 뒤(1), 순번 열이 앞에 붙은 경우(2) 둘 다.
      // 헤더 판정·순번 열 판정이 모두 합쳐진 토큰을 보게 하려고 가장 앞에서 한다.
      const merged = mergePic(mergePic(tokens, 2), 1)
      // 첫 유효 줄이 필드로 안 읽히고 헤더 키워드를 품으면 열 매핑 모드
      if (rows.length === 0 && !headerMapped && (merged.length < 2 || !parseLength(merged[1]) && !(merged.length >= 3 && /^\d+$/.test(merged[0]) && parseLength(merged[2])))) {
        const h = mapHeader(splitCells(rawLine))
        if (h) { header = h; headerMapped = true; return }
      }
      let toks = merged
      if (toks.length >= 3 && /^\d+$/.test(toks[0]) && !parseLength(toks[1]) && parseLength(toks[2])) toks = toks.slice(1) // 순번 열
      if (toks.length < 2) { warnings.push({ line: lineNo, text: rawLine, reason: '이름과 길이가 필요합니다 (예: 계좌번호 12 숫자)', dropped: true }); return }
      const len = parseLength(toks[1])
      if (!len) { warnings.push({ line: lineNo, text: rawLine, reason: `길이를 읽을 수 없음: '${toks[1]}'`, dropped: true }); return }
      draft = { name: unquote(toks[0]), length: len.length, kind: len.kind, padSpec: null, value }
      for (const a of toks.slice(2)) {
        const k = kindOf(a); const ps = parsePadSpec(a); const enc = ENCODINGS[a.toLowerCase()]
        if (NO_TRIM_KINDS.has(a.toLowerCase())) draft.noTrim = true
        else if (k) draft.kind = k
        else if (ps) draft.padSpec = ps
        else if (enc) draft.encoding = enc
        else warnings.push({ line: lineNo, text: rawLine, reason: `알 수 없는 속성 '${a}' 무시` })
      }
    }
    if (!draft) return
    const row: LayoutRow = { id: '', name: draft.name, length: draft.length }
    if (draft.encoding) row.encoding = draft.encoding
    if (mode === 'request') {
      const pad = draft.padSpec ?? (draft.kind === 'num' ? { pad: 'left' as const, padChar: '0' } : { pad: 'right' as const, padChar: ' ' })
      row.pad = pad.pad; row.padChar = pad.padChar
      row.value = draft.value === null ? '' : unquote(draft.value)
    } else {
      if (draft.value !== null && draft.value !== '') warnings.push({ line: lineNo, text: rawLine, reason: '이 목록은 값이 없습니다 — "= 값" 무시' })
      if (mode === 'response') {
        if (draft.kind) row.type = draft.kind === 'num' ? 'number' : 'string'
        // 원문 = 패딩 유지(trim=false). 종류 없이 단독으로 쓰면 type 은 그대로 미정.
        if (draft.noTrim) row.trim = false
        else if (draft.kind) row.trim = true
      }
    }
    rows.push(row)
  })
  // prev id 승계: 같은 위치 같은 이름 → 이름 첫 매칭 → 새 id. bound 복원(값이 같은 토큰이면).
  const used = new Set<string>()
  rows.forEach((r, i) => {
    const byPos = prev[i] && (prev[i].name ?? '') === (r.name ?? '') && !used.has(prev[i].id) ? prev[i] : undefined
    const p = byPos ?? prev.find((x) => !used.has(x.id) && (x.name ?? '') === (r.name ?? ''))
    r.id = p ? p.id : newId()
    if (p) used.add(p.id)
    if (mode === 'request' && p?.bound && r.value === bindingToToken(p.bound)) { r.bound = p.bound; r.value = null }
  })
  return { rows, warnings, headerMapped }
}

export function tcpLayoutForm(mode: LayoutMode): TextForm<LayoutRow> {
  const placeholder = mode === 'request'
    ? '한 줄에 필드 하나 — 이름 길이 종류 [= 값]\n전문코드 4 문자 = 0200\n계좌번호 12 숫자 = {{ acct@set1 }}\n(엑셀 정의서 행을 그대로 붙여넣어도 됩니다: 항목명 / 길이 / 타입 / 기본값)'
    : mode === 'response'
      ? '한 줄에 필드 하나 — 이름 길이 [종류] [원문]\n응답코드 4 문자\n잔액 12 숫자   (숫자 = 선행 0 제거 + 숫자 출력)\n고객명 10 문자 원문   (원문 = 패딩을 떼지 않음)'
      : '한 줄에 필드 하나 — 이름 길이 [인코딩]\n전문코드 4\n계좌번호 10\n고객명 10 EUC-KR'
  return {
    id: `tcp-${mode}`,
    label: '고정길이 전문 텍스트(한 줄 = 한 필드)',
    placeholder,
    toText: (rows) => tcpLayoutToText(rows, mode),
    fromText: (text, prev) => { const r = parseTcpLayout(text, mode, prev); return { rows: r.rows, warnings: r.warnings } },
  }
}

// ───────────────────────── 키-값 폼(HTTP 본문/쿼리/헤더) ─────────────────────────
export interface KvRow { id: string; key: string; value: string; type?: string }
const BARE_TYPES = new Set(['number', 'boolean', 'json', 'array'])
const isSingleToken = (v: string) => /^\{\{[^{}]*\}\}$/.test(v.trim())

/** 문자열 밖의 {{…}} 를 "__FLTKn__" 문자열 리터럴로 치환(문자열 안은 그대로) — JSON.parse 가능하게. */
export function protectBareTokens(text: string): { json: string; tokens: string[] } {
  const tokens: string[] = []
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) { out += text[i + 1]; i++ } else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; out += ch; continue }
    if (ch === '{' && text[i + 1] === '{') {
      const end = text.indexOf('}}', i + 2)
      if (end > 0) { tokens.push(text.slice(i, end + 2)); out += `"__FLTK${tokens.length - 1}__"`; i = end + 1; continue }
    }
    out += ch
  }
  return { json: out, tokens }
}

/** 파싱 결과 행에 prev 의 id 를 승계(같은 위치·같은 키 우선 → 키 첫 매칭 → 새 id). React key·TokenInput 안정. */
function reuseIds<T extends { id: string; key: string }>(rows: Array<Omit<T, 'id'>>, prev: T[]): T[] {
  const used = new Set<string>()
  return rows.map((r, i) => {
    const p = (prev[i] && prev[i].key === r.key && !used.has(prev[i].id) ? prev[i] : undefined) ?? prev.find((x) => !used.has(x.id) && x.key === r.key)
    if (p) used.add(p.id)
    return { ...r, id: p ? p.id : newId() } as T
  })
}

export const jsonBodyForm: TextForm<KvRow> = {
  id: 'json-body', label: 'JSON 본문', placeholder: '{\n  "name": "kim",\n  "amount": {{ amt@prev }}\n}',
  toText: (rows) => fieldsToRaw(rows.map((r) => (r.type && BARE_TYPES.has(r.type) && isSingleToken(r.value ?? '') ? { ...r, type: 'raw' } : r)), 'json'),
  fromText: (text, prev) => {
    const { json, tokens } = protectBareTokens(text)
    const parsed = rawToFields(json, 'json')
    if (parsed === null) return { rows: [], warnings: [{ line: 1, text: text.slice(0, 80), reason: '유효한 JSON 객체가 아닙니다' }] }
    const rows = parsed.map((kv) => {
      const m = /^__FLTK(\d+)__$/.exec(kv.value)
      if (!m) return { key: kv.key, value: kv.value.replace(/__FLTK(\d+)__/g, (_s, n) => tokens[Number(n)] ?? _s), type: kv.type }
      const pt = prev.find((p) => p.key === kv.key)?.type
      return { key: kv.key, value: tokens[Number(m[1])] ?? kv.value, type: pt && BARE_TYPES.has(pt) ? pt : 'json' }
    })
    return { rows: reuseIds<KvRow>(rows, prev), warnings: [] }
  },
}

const encodePart = (s: string) => segmentValue(s).map((seg) => (seg.type === 'token' ? seg.raw : encodeURIComponent(seg.text))).join('')
const decodePercent = (s: string) => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m) } catch { return m } })

export const kvUrlForm: TextForm<KvRow> = {
  id: 'kv-url', label: 'urlencoded (키=값&키=값)', placeholder: 'a=1&b={{ x@n1 }}',
  toText: (rows) => rows.filter((r) => r.key.trim() !== '').map((r) => `${encodePart(r.key)}=${encodePart(r.value ?? '')}`).join('&'),
  fromText: (text, prev) => {
    const t = text.trim()
    const rows = t === '' ? [] : t.split('&').filter((p) => p !== '').map((pair) => {
      const i = pair.indexOf('=')
      return { key: decodePercent((i >= 0 ? pair.slice(0, i) : pair).trim()), value: i >= 0 ? decodePercent(pair.slice(i + 1)) : '' }
    })
    return { rows: reuseIds<KvRow>(rows, prev), warnings: [] }
  },
}

export const headersForm: TextForm<KvRow> = {
  id: 'headers', label: '헤더 (이름: 값 줄바꿈)', placeholder: 'Content-Type: application/json\nX-Api-Key: {{ key@secret }}',
  toText: (rows) => headersToRaw(rows),
  fromText: (text, prev) => {
    const warnings: ParseWarning[] = []
    const rows: Array<Omit<KvRow, 'id'>> = []
    text.split(/\r?\n/).forEach((raw, idx) => {
      const l = raw.trim()
      if (l === '') return
      const i = l.indexOf(':')
      const key = i > 0 ? l.slice(0, i).trim() : ''
      if (!key) { warnings.push({ line: idx + 1, text: raw, reason: '"이름: 값" 형식이 아닙니다' }); return }
      rows.push({ key, value: l.slice(i + 1).trim() })
    })
    return { rows: reuseIds<KvRow>(rows, prev), warnings }
  },
}
