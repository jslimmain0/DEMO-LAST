import { catalogIdentity, catalogReturnLink, catalogSearch, catalogState, readCatalogView, type CatalogScope } from './catalogNavigation'
import { workspaceStorageKey } from './workspaceNavigation'

type Section = 'flows' | 'mocks' | 'resources' | 'executions'
interface Location { pathname: string; search: string; state?: unknown }
interface Link { to: string; state?: unknown }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>
const sectionOf = (location: Location): Section | null => location.pathname.startsWith('/flows') ? 'flows'
  : location.pathname.startsWith('/mocks') ? 'mocks'
  : location.pathname === '/executions' ? 'executions'
  : location.pathname === '/resources' && new URLSearchParams(location.search).get('tab') !== 'secrets' ? 'resources' : null
const localKey = (section: Section) => `fl:workbench:local:${section}`
const accountKey = (section: Section, scope: CatalogScope) => `${workspaceStorageKey(scope.remoteKey)}:view:${section}`
function currentLink(section: Section, location: Location, scope: CatalogScope): Link {
  if ((section === 'flows' || section === 'mocks') && location.pathname !== `/${section}`) return catalogReturnLink(location.state, section, scope)
  const params = new URLSearchParams(section === 'mocks' ? catalogSearch('mocks', scope, location.search, location.state) : location.search)
  params.set('space', `${scope.current.origin}:${scope.current.id}`)
  if (section === 'resources') params.set('tab', 'environments')
  return { to: `/${section}?${params}`, ...(section === 'flows' || section === 'mocks' ? { state: catalogState({}, section, catalogIdentity(scope, section), readCatalogView(location.state, section, catalogIdentity(scope, section))) } : {}) }
}
function readLink(value: unknown, section: Section, origin: 'local' | 'server'): Link | null {
  if (!value || typeof value !== 'object' || !('to' in value) || typeof value.to !== 'string' || !value.to.startsWith(`/${section}?`)) return null
  const params = new URLSearchParams(value.to.slice(value.to.indexOf('?') + 1))
  const space = params.get('space')?.match(/^(local|server):(.+)$/)
  if (params.getAll('space').length !== 1 || space?.[1] !== origin) return null
  if (section === 'resources' && params.get('tab') !== 'environments') return null
  return { to: value.to, ...('state' in value ? { state: value.state } : {}) }
}
function read(storage: Storage, key: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(storage.getItem(key) ?? 'null'); return value && typeof value === 'object' ? value as Record<string, unknown> : null } catch { return null }
}

/** 공통 자원 탐색은 작업별 PC/서버 목록 위치를 바꾸지 않는다. */
export function rememberWorkbenchLocation(location: Location, scope: CatalogScope, storage: Storage) {
  const section = sectionOf(location)
  if (!section) return
  const link = currentLink(section, location, scope)
  try {
    if (section === 'mocks') { storage.setItem(accountKey(section, scope), JSON.stringify({ link })); return }
    if (scope.current.origin === 'local') storage.setItem(localKey(section), JSON.stringify(link))
    storage.setItem(accountKey(section, scope), JSON.stringify({ origin: scope.current.origin, ...(scope.current.origin === 'server' ? { link } : {}) }))
  } catch { /* private mode */ }
}

export function workbenchMenuLink(section: Section, location: Location, scope: CatalogScope, storage: Storage, localId?: string): Link {
  if (sectionOf(location) === section) return currentLink(section, location, scope)
  const saved = read(storage, accountKey(section, scope))
  const remote = section === 'mocks' ? readLink(saved?.link, section, 'server') ?? readLink(saved?.link, section, 'local') : saved?.origin === 'server' ? readLink(saved.link, section, 'server') : null
  const local = section !== 'mocks' && localId ? readLink(read(storage, localKey(section)), section, 'local') : null
  const params = new URLSearchParams({ space: localId ? `local:${localId}` : 'server:public' })
  if (section === 'resources') params.set('tab', 'environments')
  return remote ?? local ?? { to: `/${section}?${params}` }
}
