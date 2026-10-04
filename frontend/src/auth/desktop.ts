import axios from 'axios'
import { appBase } from '../lib/appBase'

// 항상 PC API로 보낸다. 화면이 서버 공간을 보고 있어도 연결/로그아웃은 개인 에이전트가 담당한다.
const local = axios.create({ baseURL: `${appBase()}/api/v1/desktop` })
export interface DesktopUpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'installing' | 'error'
  currentVersion: string
  availableVersion: string | null
  downloadedBytes: number
  totalBytes: number
  message: string
  releaseNotes: string | null
}
export interface DesktopConnection { serverUrl: string; mcpUrl: string; login: string | null; connected: boolean }
export interface EnvironmentBindingsScope { origin: 'local' | 'server'; workspaceId: string; environment: string | null }
export interface EnvironmentBindings { bindings: Record<string, string>; revision: string }
const bindingHeaders = (connection: DesktopConnection) => ({ 'X-FlowLink-Server': connection.serverUrl, 'X-FlowLink-Account': connection.login ?? '' })
export const desktopApi = {
  updateStatus: () => local.get<DesktopUpdateStatus>('/update').then(r => r.data),
  checkUpdate: () => local.post<DesktopUpdateStatus>('/update/check').then(r => r.data),
  downloadUpdate: () => local.post<DesktopUpdateStatus>('/update/download').then(r => r.data),
  openUpdateWindow: () => local.post<{ opened: true }>('/update/open-window').then(r => r.data),
  connection: () => local.get<DesktopConnection>('/connection').then(r => r.data),
  configure: (serverUrl: string) => local.put<DesktopConnection>('/connection', { serverUrl }).then(r => r.data),
  login: () => local.post('/login/native'),
  logout: () => local.post('/logout'),
  environmentBindings: (scope: EnvironmentBindingsScope, connection: DesktopConnection) => local.get<EnvironmentBindings>('/environment-bindings', { params: scope, headers: bindingHeaders(connection) }).then(r => r.data),
  saveEnvironmentBindings: (scope: EnvironmentBindingsScope, value: EnvironmentBindings, connection: DesktopConnection) => local.put<EnvironmentBindings>('/environment-bindings', { ...scope, ...value }, { headers: bindingHeaders(connection) }).then(r => r.data),
}
export function switchRuntime(target: 'local' | 'server') {
  try { localStorage.removeItem('fl:workspace:selection') } catch { /* private mode */ }
  window.location.assign(`${appBase()}/flows?space=${target}:${target === 'local' ? 'local' : 'public'}`)
}
