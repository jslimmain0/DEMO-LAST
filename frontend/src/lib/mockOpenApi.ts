import type { MockRouteSpec } from '../api/types'
import { newId } from './ids'

// OpenAPI/Swagger 문서(JSON) → mock 라우트. path+method 마다 첫 성공 응답 코드와 예시 본문으로 규칙 1개 생성.
export function openApiToMockRoutes(text: string): MockRouteSpec[] {
  let doc: Record<string, unknown>
  try { doc = JSON.parse(text) } catch { return [] }
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined
  if (!paths || typeof paths !== 'object') return []
  const out: MockRouteSpec[] = []
  const METHODS_L = ['get', 'post', 'put', 'patch', 'delete', 'head']
  for (const [path, ops] of Object.entries(paths)) {
    if (!ops || typeof ops !== 'object') continue
    for (const m of METHODS_L) {
      const op = ops[m] as Record<string, unknown> | undefined
      if (!op) continue
      const responses = (op.responses ?? {}) as Record<string, unknown>
      const codes = Object.keys(responses)
      const okCode = codes.find((c) => c.startsWith('2')) ?? codes[0] ?? 'default'
      const status = /^\d+$/.test(okCode) ? Number(okCode) : 200
      // 예시 응답: responses[code].content['application/json'].example / schema.example, 없으면 {}
      let body = '{}'
      try {
        const resp = responses[okCode] as Record<string, unknown> | undefined
        const content = (resp?.content ?? {}) as Record<string, { example?: unknown; schema?: { example?: unknown } }>
        const jsonCt = Object.keys(content).find((k) => k.includes('json'))
        const ex = jsonCt ? (content[jsonCt].example ?? content[jsonCt].schema?.example) : (resp?.example ?? (resp?.examples as Record<string, { value?: unknown }> | undefined)?.[Object.keys((resp?.examples as object) ?? {})[0]]?.value)
        if (ex !== undefined) body = JSON.stringify(ex, null, 2)
      } catch { /* 예시 없으면 {} */ }
      out.push({ id: newId(), method: m.toUpperCase(), path: String(path), rules: [{ id: newId(), status, contentType: 'json', body }] })
    }
  }
  return out
}
