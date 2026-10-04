import type { MockFleetServer } from '../api/types'

/** 여러 검색어는 순서와 대소문자에 관계없이 모두 일치해야 한다. */
export function matchesCatalog(query: string, values: Array<string | number | null | undefined>): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
  const text = normalize(values.filter(v => v != null).join(' '))
  return normalize(query).trim().split(/\s+/).filter(Boolean).every(part => text.includes(part))
}

export function catalogPage(total: number, requested: number, size: number) {
  const pageSize = Math.max(1, Math.floor(size))
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.max(1, Math.min(pages, Math.floor(requested)))
  const start = (page - 1) * pageSize
  return { page, pages, start, end: Math.min(total, start + pageSize) }
}

export type MockSort = 'name' | 'recent' | 'state' | 'port'
export function compareMocks(sort: MockSort, state: (s: MockFleetServer) => string) {
  const rank: Record<string, number> = { fail: 0, on: 1, off: 2 }
  return (a: MockFleetServer, b: MockFleetServer) => {
    let primary = 0
    if (sort === 'recent') primary = (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0)
    if (sort === 'state') primary = rank[state(a)] - rank[state(b)]
    if (sort === 'port') primary = (a.tcpPort ?? 0) - (b.tcpPort ?? 0)
    return primary || a.name.localeCompare(b.name, 'ko', { numeric: true }) || a.id.localeCompare(b.id)
  }
}
