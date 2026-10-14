import type { DesktopConnection, DesktopUpdateStatus } from '../auth/desktop'

export const desktopUpdateStatusKey = ['desktop', 'update'] as const
export const updateNoticeChanged = 'fl:desktop:update-notice'
export function updateNoticeKey(connection: DesktopConnection, info: DesktopUpdateStatus) {
  return `fl:desktop:update-notice:${connection.serverUrl}:${info.loginRequired ? 'login:' + info.currentVersion : info.availableVersion ?? info.currentVersion}`
}
export function updateNoticeVisible(key: string, now = Date.now()) {
  try {
    const value = localStorage.getItem(key)
    return value !== 'hidden' && (!value || !Number.isFinite(Number(value)) || Number(value) <= now)
  } catch { return true }
}
export function setUpdateNotice(key: string, until: number | 'hidden' | null) {
  try { if (until === null) localStorage.removeItem(key); else localStorage.setItem(key, String(until)) } catch { /* private mode */ }
  window.dispatchEvent(new Event(updateNoticeChanged))
}
