/**
 * TCP 전문 길이 산술 — 화면에 **늘 보이는** 세 숫자(본문 · 프리픽스 · 전송)와
 * 전문 안 길이 필드(전문길이)의 불일치 판정. 백엔드 `TcpLen`(= `{{len}}` 토큰)과 같은 의미:
 *
 *   본문(body)   = 고정길이 필드 선언 길이의 합(프리픽스 제외)  → `{{len}}`
 *   전송(frame)  = 본문 + 프리픽스 폭                            → `{{len:frame}}`
 *   프리픽스에 실리는 숫자 = `프리픽스 포함 길이` 켜짐이면 frame, 꺼짐이면 body
 *
 * 길이가 두 개(소켓 프리픽스 / 전문 안 길이 필드)라 헷갈리던 것을 한 줄로 펴 보여주는 게 목적 —
 * 순수 함수라 단위 테스트로 산술을 고정한다(브라우저 확인 불가 환경).
 */

export interface TcpFrame {
  /** 본문 바이트(프리픽스 제외) */
  body: number
  /** 프리픽스 폭(자리수 · 0 = 프리픽스 없음) */
  prefix: number
  /** 전송 총 바이트 = body + prefix */
  frame: number
  /** 프리픽스에 실리는 숫자 */
  declared: number
  /** 위 숫자를 프리픽스 폭으로 0 패딩('' = 프리픽스 없음) */
  declaredText: string
  includesSelf: boolean
}

/** 고정길이 필드들의 선언 길이 합(바이트). */
export function sumFieldBytes(fields: ReadonlyArray<{ length?: number | null }> | null | undefined): number {
  return (fields ?? []).reduce((a, f) => a + Math.max(0, Math.floor(f.length ?? 0)), 0)
}

/** [width] 자리 0 패딩 — 넘치면 하위 [width] 자리만(폭 불변, 백엔드 TcpLen.format·TcpBytes.prefix 규약). */
export function padNum(value: number, width: number): string {
  const v = Math.max(0, Math.floor(value))
  if (width <= 0) return String(v)
  const s = String(v).padStart(width, '0')
  return s.length > width ? s.slice(s.length - width) : s
}

/** 본문 바이트 + 연결 설정(프리픽스 폭·포함 여부) → 화면에 쓸 세 숫자. */
export function tcpFrame(body: number, prefixLength?: number | null, includesSelf?: boolean | null): TcpFrame {
  const prefix = Math.max(0, Math.floor(prefixLength ?? 0))
  const b = Math.max(0, Math.floor(body))
  const frame = b + prefix
  const inc = !!includesSelf
  const declared = inc ? frame : b
  return { body: b, prefix, frame, declared, declaredText: prefix > 0 ? padNum(declared, prefix) : '', includesSelf: inc }
}

const incLabel = (f: TcpFrame) => (f.includesSelf ? '포함 길이 켜짐' : '포함 길이 꺼짐')
/** 체크박스를 반대로 두면 프리픽스에 실릴 값 — "0208 인데 왜 0200?" 을 한눈에 풀어주는 짝 숫자. */
const otherText = (f: TcpFrame) => padNum(f.includesSelf ? f.body : f.frame, f.prefix)

/** 워크플로 TCP 노드 요청(=내가 보낸다): `본문 204B + 프리픽스 4B = 전송 208B · 프리픽스 값 "0208"(포함 길이 켜짐)` */
export function requestFrameLine(f: TcpFrame): string {
  if (f.prefix <= 0) return `본문 ${f.body}B · 프리픽스 없음 — 연결당 1전문(EOF)`
  return `본문 ${f.body}B + 프리픽스 ${f.prefix}B = 전송 ${f.frame}B · 프리픽스 값 "${f.declaredText}"(${incLabel(f)})`
}

/** Mock 요청 레이아웃(=내가 받는다): `본문 200B 를 기다림 · 프리픽스 4B 값 "0204"(포함 길이 켜짐 · 끄면 "0200")` */
export function incomingFrameLine(f: TcpFrame): string {
  if (f.prefix <= 0) return `본문 ${f.body}B 를 기다림 · 프리픽스 없음 — 연결당 1전문(EOF)`
  return `본문 ${f.body}B 를 기다림 · 프리픽스 ${f.prefix}B 값 "${f.declaredText}"(${incLabel(f)} · 끄면 "${otherText(f)}")`
}

/** Mock 규칙 응답(=내가 보낸다): `응답 본문 40B + 프리픽스 4B = 나가는 전문 44B` */
export function outgoingFrameLine(f: TcpFrame): string {
  if (f.prefix <= 0) return `응답 본문 ${f.body}B · 프리픽스 없음`
  return `응답 본문 ${f.body}B + 프리픽스 ${f.prefix}B = 나가는 전문 ${f.frame}B`
}

/** 이 길이를 자동으로 채우는 토큰 — 폭이 있으면 0 패딩(`{{len:4}}`). */
export function lenToken(width?: number | null): string {
  const w = Math.max(0, Math.floor(width ?? 0))
  return w > 0 ? `{{len:${w}}}` : '{{len}}'
}

const LEN_WORDS = [
  'len', 'length', '길이', '전문길이', '전체길이', '본문길이', '메시지길이', '데이터길이',
  'msglen', 'msglength', 'bodylen', 'bodylength', 'totallen', 'totallength', 'datalen', 'datalength',
]

/** 이름이 '전문 안 길이 필드'로 보이는가 — 경고/{{len}} 버튼을 붙일 행 판별(자문일 뿐 편집을 막지 않는다). */
export function isLenFieldName(name?: string | null): boolean {
  const n = (name ?? '').trim().toLowerCase().replace(/[\s_\-.]/g, '')
  if (!n) return false
  if (LEN_WORDS.includes(n)) return true
  return n.endsWith('길이') || n.endsWith('length') || n.endsWith('len')
}

/** 손으로 적은 숫자 리터럴만 판정 대상 — 토큰({{ }})이나 문자 섞인 값은 판단하지 않는다(null). */
export function literalLenValue(value?: string | null): number | null {
  const v = (value ?? '').trim()
  if (!v || v.includes('{{')) return null
  if (!/^\d+$/.test(v)) return null
  return Number(v)
}

/**
 * 전문 안 길이 필드가 본문/전송 어느 쪽과도 안 맞으면 경고 문구, 맞으면 null.
 * (본문·전송 둘 중 하나와 같으면 프로토콜 규약 차이일 뿐이라 경고하지 않는다.)
 */
export function lenFieldWarning(field: { name?: string | null; length?: number | null; value?: string | null }, f: TcpFrame): string | null {
  if (!isLenFieldName(field.name)) return null
  const n = literalLenValue(field.value)
  if (n == null) return null
  if (n === f.body || n === f.frame) return null
  return `본문 ${f.body}B · 전송 ${f.frame}B 와 다릅니다 — ${lenToken(field.length)} 를 쓰면 자동으로 채워집니다`
}

/** 실행 기록의 응답 텍스트(백엔드 TcpNodeExecutor 가 `응답 200B\n…` 로 기록) → 수신 바이트 수. */
export function receivedBytes(responseText?: string | null): number | null {
  const m = /^응답\s*(\d+)\s*B/.exec((responseText ?? '').trim())
  return m ? Number(m[1]) : null
}

/** 응답 필드 선언 합 vs 실제 수신 바이트 — 같으면 ✓, 다르면 모자람/남음. */
export function receivedCompare(declared: number, received: number): { ok: boolean; text: string } {
  const d = Math.max(0, Math.floor(declared))
  const r = Math.max(0, Math.floor(received))
  if (d === r) return { ok: true, text: `선언 ${d}B / 수신 ${r}B ✓` }
  return { ok: false, text: `선언 ${d}B / 수신 ${r}B ⚠ ${Math.abs(d - r)}B ${r < d ? '모자람' : '남음'}` }
}
