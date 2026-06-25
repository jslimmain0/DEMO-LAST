// 노드/엣지 id 발급기. (D5) sourceId 토큰 클래스가 [A-Za-z0-9]+ 이므로
// '-'/'_' 가 섞이는 nanoid 기본값을 쓰면 토큰 파싱이 silent fail 한다 → 영숫자만 사용.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function newId(len = 8): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return out
}

/** 토큰 sourceId 로 안전한 id 인지(영숫자만). */
export function isTokenSafeId(id: string): boolean {
  return /^[A-Za-z0-9]+$/.test(id)
}

/** 토큰에 안전하지 않은 id(import 등)를 영숫자로 정규화. */
export function normalizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9]/g, '')
  return cleaned.length > 0 ? cleaned : newId()
}
