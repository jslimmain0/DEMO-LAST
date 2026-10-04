import type { WorkspaceRef } from '../app/WorkspaceContext'

export const workspaceIdentity = (w: WorkspaceRef) => `${w.origin}:${w.id}`
export const workspaceStorageKey = (remoteKey: string) => `fl:workspace-navigation:${remoteKey.replace(/:(true|false)$/, '')}`
export function readWorkspaceNavigation(key: string): { favorites: string[]; recent: string[] } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return { favorites: Array.isArray(value.favorites) ? value.favorites : [], recent: Array.isArray(value.recent) ? value.recent : [] }
  } catch { return { favorites: [], recent: [] } }
}
export function visitWorkspace(key: string, w: WorkspaceRef) {
  const saved = readWorkspaceNavigation(key)
  const id = workspaceIdentity(w)
  try { localStorage.setItem(key, JSON.stringify({ ...saved, recent: [id, ...saved.recent.filter(x => x !== id)].slice(0, 8) })) } catch { /* private mode */ }
}
