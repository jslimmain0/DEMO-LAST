export type CatalogSection = 'flows' | 'mocks'
export interface CatalogView {
  search: string
  sort: string
  page: number
  size: number
  filter: string
  kind: string
}
export interface CatalogScope { scopeKey: string; remoteKey: string; current: { origin: string; id: string } }
interface CatalogEntry { identity: string; section: CatalogSection; view: CatalogView }
export interface CatalogLink { to: string; state: { catalog?: CatalogEntry; catalogReturn?: { to: string; catalog: CatalogEntry } } }
const object = (value: unknown): Record<string, unknown> => value != null && typeof value === 'object' ? value as Record<string, unknown> : {}
export const catalogIdentity = (scope: CatalogScope) => JSON.stringify([scope.scopeKey, scope.remoteKey.replace(/:(true|false)$/, '')])
export const catalogSpace = (scope: CatalogScope) => `${scope.current.origin}:${scope.current.id}`
export function catalogDefaults(section: CatalogSection): CatalogView {
  return { search: '', sort: section === 'flows' ? 'recent' : 'name', page: 1, size: 25, filter: 'all', kind: 'all' }
}
function readEntry(value: unknown, section: CatalogSection, identity: string): CatalogEntry | null {
  const entry = object(value), view = object(entry.view)
  if (entry.identity !== identity || entry.section !== section) return null
  const defaults = catalogDefaults(section)
  const sorts = section === 'flows' ? ['recent', 'name'] : ['name', 'recent', 'state', 'port']
  return { identity, section, view: {
    search: typeof view.search === 'string' ? view.search : '',
    sort: sorts.includes(String(view.sort)) ? String(view.sort) : defaults.sort,
    page: typeof view.page === 'number' && Number.isSafeInteger(view.page) && view.page > 0 ? view.page : 1,
    size: [25, 50, 100].includes(Number(view.size)) ? Number(view.size) : 25,
    filter: ['all', 'on', 'off', 'fail', 'live', 'unmatched', 'fav'].includes(String(view.filter)) ? String(view.filter) : 'all',
    kind: ['all', 'HTTP', 'TCP'].includes(String(view.kind)) ? String(view.kind) : 'all',
  } }
}
export function readCatalogView(state: unknown, section: CatalogSection, identity: string): CatalogView {
  return readEntry(object(state).catalog, section, identity)?.view ?? catalogDefaults(section)
}
export function catalogState(state: unknown, section: CatalogSection, identity: string, view: CatalogView) {
  return { ...object(state), catalog: { identity, section, view } }
}
export function catalogListUrl(section: CatalogSection, scope: CatalogScope, search = '') {
  const params = new URLSearchParams(search)
  params.set('space', catalogSpace(scope))
  return `/${section}?${params}`
}
export function catalogDetailLink(section: CatalogSection, id: string, scope: CatalogScope, search: string, view: CatalogView): CatalogLink {
  const catalog: CatalogEntry = { identity: catalogIdentity(scope), section, view }
  return { to: `/${section}/${encodeURIComponent(id)}?space=${encodeURIComponent(catalogSpace(scope))}`,
    state: { catalogReturn: { to: catalogListUrl(section, scope, search), catalog } } }
}
export function catalogReturnLink(state: unknown, section: CatalogSection, scope: CatalogScope, folder?: string | null): CatalogLink {
  const saved = object(object(state).catalogReturn)
  const entry = readEntry(saved.catalog, section, catalogIdentity(scope))
  if (entry && typeof saved.to === 'string' && saved.to.startsWith(`/${section}?`)) {
    const params = new URLSearchParams(saved.to.slice(saved.to.indexOf('?') + 1))
    if (params.getAll('space').length === 1 && params.get('space') === catalogSpace(scope)) {
      return { to: catalogListUrl(section, scope, params.toString()), state: { catalog: entry } }
    }
  }
  const params = new URLSearchParams()
  if (section === 'flows' && folder) params.set('folder', folder)
  return { to: catalogListUrl(section, scope, params.toString()), state: {} }
}
