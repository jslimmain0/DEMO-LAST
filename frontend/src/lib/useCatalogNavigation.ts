import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useWorkspace } from '../app/WorkspaceContext'
import { catalogDetailLink, catalogIdentity, catalogListUrl, catalogReturnLink, catalogState, readCatalogView, type CatalogSection, type CatalogView } from './catalogNavigation'

/** A list's history entry owns its browsing context; no global storage or cross-account reuse. */
export function useCatalogNavigation(section: CatalogSection) {
  const scope = useWorkspace()
  const location = useLocation()
  const navigate = useNavigate()
  const identity = catalogIdentity(scope)
  const view = readCatalogView(location.state, section, identity)
  const draft = useRef({ location, identity, view })
  if (draft.current.location !== location || draft.current.identity !== identity) draft.current = { location, identity, view }
  const update = (patch: Partial<CatalogView>, search = location.search, replace = true) => {
    // Synchronous merges keep multiple controls in one event (e.g. reset filters) intact.
    const next = { ...draft.current.view, ...patch }
    draft.current.view = next
    navigate(catalogListUrl(section, scope, search), { replace, state: catalogState(location.state, section, identity, next) })
  }
  return { view, update, detail: (id: string) => catalogDetailLink(section, id, scope, location.search, draft.current.view) }
}

export function useCatalogReturn(section: CatalogSection, folder?: string | null) {
  return catalogReturnLink(useLocation().state, section, useWorkspace(), folder)
}
