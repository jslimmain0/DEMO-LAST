// 노드/엣지 id 발급기. (D5) 신규 id 는 영숫자만 사용(토큰 문법과 가장 안전한 교집합).
// 토큰 sourceId 클래스는 [\w-]+ 로 넓혀 가져온 그래프의 kebab/snake id 도 바인딩된다(tokenGrammar 참조).
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
