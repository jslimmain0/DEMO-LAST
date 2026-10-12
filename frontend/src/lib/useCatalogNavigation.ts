import { useRef } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { useWorkspace } from '../app/WorkspaceContext'
import { catalogDetailLink, catalogIdentity, catalogListUrl, catalogReturnLink, catalogSearch, catalogState, readCatalogView, type CatalogSection, type CatalogView } from './catalogNavigation'

/** A list's history entry owns its browsing context; no global storage or cross-account reuse. */
export function useCatalogNavigation(section: CatalogSection) {
  const scope = useWorkspace()
  const location = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const identity = catalogIdentity(scope, section)
  const source = location.pathname === `/${section}` ? null : catalogReturnLink(location.state, section, scope)
  const search = source ? source.to.slice(source.to.indexOf('?')) : catalogSearch(section, scope, location.search, location.state)
  const view = readCatalogView(source?.state ?? location.state, section, identity)
  const draft = useRef({ location, identity, view, search, pending: [] as Array<{ to: string; view: CatalogView }> })
  if (draft.current.location !== location || draft.current.identity !== identity) {
    const pending = draft.current.pending
    const index = identity === draft.current.identity && navigationType !== 'POP' && location.pathname === `/${section}`
      ? pending.findIndex(entry => entry.to === catalogListUrl(section, scope, search) && JSON.stringify(entry.view) === JSON.stringify(view)) : -1
    // 중간 replace 응답이 도착해도 방금 입력한 검색과 대상 선택을 덮지 않는다.
    if (index >= 0 && index < pending.length - 1) draft.current.location = location
    else draft.current = { location, identity, view, search, pending: [] }
  }
  const update = (patch: Partial<CatalogView>, nextSearch = draft.current.search, replace = true) => {
    // Synchronous merges keep multiple controls in one event (e.g. reset filters) intact.
    const next = { ...draft.current.view, ...patch }
    draft.current.view = next
    draft.current.search = nextSearch
    const to = catalogListUrl(section, scope, nextSearch)
    draft.current.pending.push({ to, view: next })
    navigate(to, { replace, state: catalogState(location.state, section, identity, next) })
  }
  return { view: draft.current.view, search: draft.current.search, update, detail: (id: string, target: { origin: string; id: string } = scope.current) => catalogDetailLink(section, id, scope, draft.current.search, draft.current.view, target) }
}

export function useCatalogReturn(section: CatalogSection, folder?: string | null) {
  return catalogReturnLink(useLocation().state, section, useWorkspace(), folder)
}
