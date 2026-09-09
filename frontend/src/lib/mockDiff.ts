import type { MockServerSpec } from '../api/types'

/** Mock 정의 두 스냅샷의 요약 diff — 라우트/TCP 규칙은 id 로 대조(추가/삭제/변경), 코덱·레이아웃·환경은 변경 여부. */
export interface MockSpecDiff {
  same: boolean
  routes: { added: string[]; removed: string[]; changed: string[] }
  tcpRules: { added: number; removed: number; changed: number }
  codecChanged: boolean
  tcpConnChanged: boolean   // 포트/문자셋/프리픽스/레이아웃
  environmentChanged: boolean
}

const j = (v: unknown) => JSON.stringify(v ?? null)

export function diffMockSpecs(a: MockServerSpec, b: MockServerSpec): MockSpecDiff {
  const ra = new Map((a.routes ?? []).map((r) => [r.id, r]))
  const rb = new Map((b.routes ?? []).map((r) => [r.id, r]))
  const label = (r: { method: string; path: string }) => `${r.method} ${r.path}`
  const routes = { added: [] as string[], removed: [] as string[], changed: [] as string[] }
  for (const [id, r] of rb) { if (!ra.has(id)) routes.added.push(label(r)); else if (j(ra.get(id)) !== j(r)) routes.changed.push(label(r)) }
  for (const [id, r] of ra) if (!rb.has(id)) routes.removed.push(label(r))
  const ta = new Map((a.tcp?.rules ?? []).map((r) => [r.id, r]))
  const tb = new Map((b.tcp?.rules ?? []).map((r) => [r.id, r]))
  const tcpRules = { added: 0, removed: 0, changed: 0 }
  for (const [id, r] of tb) { if (!ta.has(id)) tcpRules.added++; else if (j(ta.get(id)) !== j(r)) tcpRules.changed++ }
  for (const id of ta.keys()) if (!tb.has(id)) tcpRules.removed++
  const conn = (s: MockServerSpec) => j({ port: s.tcp?.port, charset: s.tcp?.charset, prefixLength: s.tcp?.prefixLength, prefixIncludesSelf: s.tcp?.prefixIncludesSelf, requestFields: s.tcp?.requestFields, enabled: s.tcp?.enabled })
  const codecChanged = j(a.codec) !== j(b.codec)
  const tcpConnChanged = conn(a) !== conn(b)
  const environmentChanged = (a.environment ?? null) !== (b.environment ?? null)
  const same = routes.added.length + routes.removed.length + routes.changed.length + tcpRules.added + tcpRules.removed + tcpRules.changed === 0 && !codecChanged && !tcpConnChanged && !environmentChanged
  return { same, routes, tcpRules, codecChanged, tcpConnChanged, environmentChanged }
}

export function mockDiffSummary(d: MockSpecDiff): string {
  if (d.same) return '차이 없음'
  const parts: string[] = []
  if (d.routes.added.length) parts.push(`라우트 추가 ${d.routes.added.length}`)
  if (d.routes.removed.length) parts.push(`삭제 ${d.routes.removed.length}`)
  if (d.routes.changed.length) parts.push(`변경 ${d.routes.changed.length}`)
  if (d.tcpRules.added || d.tcpRules.removed || d.tcpRules.changed) parts.push(`TCP 규칙 +${d.tcpRules.added} −${d.tcpRules.removed} ~${d.tcpRules.changed}`)
  if (d.tcpConnChanged) parts.push('TCP 연결/레이아웃 변경')
  if (d.codecChanged) parts.push('코덱 변경')
  if (d.environmentChanged) parts.push('시크릿 환경 변경')
  return parts.join(' · ')
}
