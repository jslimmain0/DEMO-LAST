// frontend/src/lib/protocolSpec.ts — 프로토콜 순수 헬퍼(오프셋·바이트 근사·붙여넣기 파서·Mock 규칙 린트). 백엔드 ProtocolSpec/ProtocolCodec 미러.
import type { FieldPad, FieldType, MockTcpSpec, ProtocolField, ProtocolSpec } from '../api/types'

export const FIELD_TYPES: FieldType[] = ['string', 'ascii', 'numeric', 'length', 'binary']
export const FIELD_PADS: FieldPad[] = ['right/space', 'left/zero', 'left/space', 'none']

export const defaultPad = (t: FieldType): FieldPad => (t === 'numeric' || t === 'length' ? 'left/zero' : t === 'binary' ? 'none' : 'right/space')
export const padOf = (f: ProtocolField): FieldPad => f.pad ?? defaultPad(f.type)

export const tableLen = (fields: ProtocolField[]): number => fields.reduce((a, f) => a + (Number(f.len) || 0), 0)

/** 본문 필드의 절대 오프셋(헤더 길이부터 누적). */
export function withOffsets(header: ProtocolField[], fields: ProtocolField[]): number[] {
  let off = tableLen(header)
  return fields.map((f) => { const o = off; off += Number(f.len) || 0; return o })
}

/** 바이트 길이 근사 — ponytail: EUC-KR/MS949 는 비ASCII 1자=2B, 그 외 UTF-8. 진짜 검증은 백엔드 미리보기/전송 전. */
export function byteLen(s: string, encoding: string): number {
  const enc = (encoding || 'EUC-KR').toUpperCase()
  if (enc === 'EUC-KR' || enc === 'MS949' || enc === 'CP949' || enc === 'X-WINDOWS-949') {
    let n = 0; for (const ch of s) n += ch.charCodeAt(0) > 0x7f ? 2 : 1; return n
  }
  if (enc === 'US-ASCII' || enc === 'ASCII') return s.length
  return new TextEncoder().encode(s).length
}

export function lengthNumbers(spec: ProtocolSpec, key: string): { total: number; bodyOnly: number; withSelf: number } {
  const msg = spec.messages.find((m) => m.key === key)
  const total = tableLen(spec.header) + (msg ? tableLen(msg.fields) : 0)
  const lf = spec.header.find((f) => f.name === spec.lengthField)
  return { total, bodyOnly: total - (lf ? Number(lf.len) || 0 : 0), withSelf: total }
}

const TYPE_ALIAS: Record<string, FieldType> = {
  length: 'length', len: 'length', 길이: 'length',
  string: 'string', str: 'string', char: 'string', 문자: 'string', 한글: 'string', text: 'string',
  ascii: 'ascii', an: 'ascii', a: 'ascii', 영문: 'ascii', 영숫자: 'ascii',
  numeric: 'numeric', num: 'numeric', n: 'numeric', number: 'numeric', 숫자: 'numeric',
  binary: 'binary', bin: 'binary', bytes: 'binary', 바이너리: 'binary',
}
const PAD_ALIAS: Record<string, FieldPad> = {
  'left/zero': 'left/zero', zero: 'left/zero', 좌0: 'left/zero', left0: 'left/zero', lz: 'left/zero',
  'right/space': 'right/space', space: 'right/space', 공백: 'right/space', 우공백: 'right/space', rs: 'right/space',
  'left/space': 'left/space', 좌공백: 'left/space', ls: 'left/space',
  '-': 'none', none: 'none', 없음: 'none',
}

/**
 * 명세서 표 붙여넣기 — 줄마다 `[번호] 이름 길이 [타입] [패딩] [offset]`(탭/공백 구분). 첫 정수 토큰이 길이, 그 앞이 이름.
 * 타입/패딩은 별칭 관용. 길이가 없는 줄(제목 등)은 skipped 로.
 */
export function parsePastedTable(text: string): { fields: ProtocolField[]; skipped: string[] } {
  const fields: ProtocolField[] = []
  const skipped: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const toks = line.split(/\t+|\s{2,}|\s+/).filter(Boolean)
    // 선행 행 번호("1", "1.", "①") 제거
    if (toks.length > 1 && /^(\d+[.)]?|[①-⑳])$/.test(toks[0]) && !/^\d+$/.test(toks[1])) toks.shift()
    const li = toks.findIndex((t, i) => i > 0 && /^\d+$/.test(t))
    if (li <= 0) { skipped.push(line); continue }
    const name = toks.slice(0, li).join(' ')
    const len = Number(toks[li])
    let type: FieldType | undefined
    let pad: FieldPad | undefined
    for (const t of toks.slice(li + 1)) {
      const k = t.toLowerCase()
      if (!type && TYPE_ALIAS[k]) { type = TYPE_ALIAS[k]; continue }
      if (!pad && PAD_ALIAS[k]) { pad = PAD_ALIAS[k]; continue }
    }
    const ty = type ?? 'string'
    fields.push({ name, len, type: ty, pad: pad ?? defaultPad(ty) })
  }
  return { fields, skipped }
}

/** 통표에서 헤더 개수만큼 잘라 본문만 남긴다. 잘린 부분이 기존 헤더 정의와 다르면 경고. */
export function splitPasted(fields: ProtocolField[], header: ProtocolField[]): { body: ProtocolField[]; mismatches: string[] } {
  const mismatches: string[] = []
  const n = Math.min(header.length, fields.length)
  for (let i = 0; i < n; i++) {
    const p = fields[i], h = header[i]
    if (p.name !== h.name || Number(p.len) !== Number(h.len)) mismatches.push(`⚠ 붙여넣은 ${i + 1}번 필드가 "${p.name}(${p.len})"인데 헤더 정의는 "${h.name}(${h.len})" — 확인 필요`)
  }
  return { body: fields.slice(header.length), mismatches }
}

export function messageKeys(spec: ProtocolSpec): { key: string; label: string }[] {
  return spec.messages.map((m) => ({ key: m.key, label: m.label ? `${m.key} · ${m.label}` : m.key }))
}
/** 송신 후보(응답 전용 키 제외). */
export function requestKeys(spec: ProtocolSpec): { key: string; label: string }[] {
  return messageKeys(spec).filter((m) => m.key !== 'response' && !m.key.endsWith(':response'))
}
/** 전문 key 의 헤더+본문 필드. */
export function fieldsOf(spec: ProtocolSpec, key: string | undefined): ProtocolField[] {
  const msg = key ? spec.messages.find((m) => m.key === key) : undefined
  return [...spec.header, ...(msg?.fields ?? [])]
}

/** Mock TCP 규칙 저장 전 경고(백엔드 400 과 별개로 UX 용). */
export function lintTcpRules(tcp: MockTcpSpec, spec: ProtocolSpec): string[] {
  const out: string[] = []
  const reqNames = new Set([...spec.header, ...spec.messages.flatMap((m) => m.fields)].map((f) => f.name))
  for (const r of tcp.rules ?? []) {
    const label = `규칙 ${r.id}`
    if (r.then?.mode === 'proxy') { if (!tcp.upstream?.trim()) out.push(`${label}: proxy 인데 upstream 이 없습니다.`); continue }
    const fields = r.then?.fields ?? {}
    const disc = spec.discriminator ? fields[spec.discriminator] : undefined
    const key = spec.discriminator ? disc : 'response'
    const msg = key ? (spec.messages.find((m) => m.key === `${key}:response`) ?? spec.messages.find((m) => m.key === key)) : undefined
    if (spec.discriminator && !disc) out.push(`${label}: 응답 전문(${spec.discriminator})을 정하세요.`)
    else if (!msg) out.push(`${label}: 응답 전문 '${key}' 정의가 없습니다.`)
    const table = new Map([...spec.header, ...(msg?.fields ?? [])].map((f) => [f.name, f] as const))
    for (const [k, v] of Object.entries(fields)) {
      const f = table.get(k)
      if (!f) { out.push(`${label}: '${k}' 는 응답 전문에 없는 필드입니다.`); continue }
      for (const m of v.matchAll(/\{\{\s*(?:req\.([^\s{}]+)|([^\s@{}]+)@req)\s*\}\}/g)) { const ref = m[1] ?? m[2]; if (!reqNames.has(ref)) out.push(`${label}: {{req.${ref}}} — 요청에 '${ref}' 필드가 없습니다.`) }
      if (!v.includes('{{')) { const b = byteLen(v, spec.encoding); if (b > f.len) out.push(`${label}: ⚠ '${k}' 값 (${b}B) → ${f.len}B — 초과분 잘림`) }
    }
  }
  return out
}

export function newProtocolSpec(): ProtocolSpec {
  return {
    encoding: 'EUC-KR', lengthField: '전문길이', lengthFormat: 'ascii-decimal', includesSelf: false, discriminator: '거래코드',
    header: [{ name: '전문길이', len: 4, type: 'length', pad: 'left/zero' }, { name: '거래코드', len: 4, type: 'ascii', pad: 'right/space' }],
    messages: [
      { key: '0210', label: '잔액조회 요청', fields: [{ name: '계좌번호', len: 13, type: 'ascii', pad: 'right/space' }, { name: '금액', len: 15, type: 'numeric', pad: 'left/zero' }] },
      { key: '0211', label: '잔액조회 응답', fields: [{ name: '응답코드', len: 4, type: 'ascii', pad: 'right/space' }, { name: '잔액', len: 15, type: 'numeric', pad: 'left/zero' }] },
    ],
  }
}
