// 일괄 붙여넣기 파서 — 환경 변수(.env)·출력 키 목록을 텍스트에서 뽑는 순수 함수.
// UI(EnvManagerDialog·OutputsEditor)가 공유한다. 실패해도 throw 하지 않고 빈 배열.

/** `.env` 스타일 텍스트 → 키/값 목록. `#` 주석·빈 줄 무시, `export ` 접두사 허용, 값 양끝 따옴표 제거. */
export function parseDotEnv(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  const seen = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s?(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    // 양끝이 같은 따옴표면 벗긴다 (KEY="a b" / KEY='a b')
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (seen.has(key)) {
      // 같은 키가 여러 번이면 마지막 값이 이긴다(.env 관례)
      const idx = out.findIndex((r) => r.key === key)
      out[idx] = { key, value }
    } else {
      seen.add(key)
      out.push({ key, value })
    }
  }
  return out
}

/** JSON 값 → 출력 타입 추론. PropertyPanel 의 '이 응답에서 키 채우기'(inferOut)와 같은 규칙. */
export function inferOutputType(v: unknown): string {
  return v === null ? 'string' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : typeof v === 'object' ? 'object' : 'string'
}

/**
 * 출력 키 일괄 텍스트 → {key, type} 목록.
 * ① JSON 객체를 붙여넣으면(샘플 응답) 최상위 키 + 타입 추론.
 * ② 아니면 줄바꿈/쉼표/공백 구분 키 나열(`code, tid message` → 3개). 중복은 첫 항목만.
 */
export function parseOutputKeys(text: string): Array<{ key: string; type: string }> {
  const t = text.trim()
  if (!t) return []
  if (t.startsWith('{')) {
    try {
      const obj: unknown = JSON.parse(t)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.entries(obj as Record<string, unknown>)
          .filter(([k]) => k.trim())
          .map(([k, v]) => ({ key: k.trim(), type: inferOutputType(v) }))
      }
    } catch { /* JSON 아님 — 아래 나열 파싱으로 */ }
  }
  const out: Array<{ key: string; type: string }> = []
  const seen = new Set<string>()
  for (const part of t.split(/[\s,;]+/)) {
    const key = part.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ key, type: 'string' })
  }
  return out
}

/** 목록에서 2회 이상 나오는 trim 된 키 집합 — 중복 경고 표시용(빈 키 제외). */
export function duplicateKeys(keys: Array<string | undefined>): Set<string> {
  const count = new Map<string, number>()
  for (const k of keys) {
    const t = (k ?? '').trim()
    if (!t) continue
    count.set(t, (count.get(t) ?? 0) + 1)
  }
  return new Set([...count.entries()].filter(([, n]) => n > 1).map(([k]) => k))
}
