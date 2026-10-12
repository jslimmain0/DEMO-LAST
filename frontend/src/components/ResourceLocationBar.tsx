import { Link } from 'react-router-dom'
import { useWorkspace } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { AppIcon } from './AppIcon'
import { readWorkspaceNavigation, visitWorkspace, workspaceIdentity, workspaceStorageKey } from '../lib/workspaceNavigation'

interface Props {
  label?: string
  combined?: boolean
  serverWorkspaceId?: string
  onServerWorkspaceChange?: (workspaceId: string) => void
}

/** combined 목록에서는 서버 필터만 바꾸고 내 PC 목록은 계속 표시한다. */
export function ResourceLocationBar({ label = '저장 위치', combined = false, serverWorkspaceId = '', onServerWorkspaceChange }: Props) {
  const scope = useWorkspace()
  const { desktop } = useAuth()
  const local = scope.workspaces.find(workspace => workspace.origin === 'local' && workspace.kind === 'PERSONAL')
  const servers = scope.workspaces.filter(workspace => workspace.origin === 'server')
  const key = workspaceStorageKey(scope.remoteKey)
  const recent = readWorkspaceNavigation(key).recent
  const recentServer = recent.map(id => servers.find(workspace => workspaceIdentity(workspace) === id)).find(Boolean)
  const selectedServerId = combined ? serverWorkspaceId : scope.current.origin === 'server' ? scope.current.id : recentServer?.id ?? 'public'
  const chooseServer = (id: string) => {
    if (combined) { onServerWorkspaceChange?.(id); return }
    const workspace = servers.find(candidate => candidate.id === id)
    if (workspace) visitWorkspace(key, workspace)
    scope.select(id, 'server')
  }
  return <div className="fl-resource-location" role="group" aria-label={label}>
    <span className="fl-location-label">{label}</span>
    {desktop && (combined ? <span className="fl-location-option fl-location-always"><AppIcon name="monitor" size={16} /><b>내 PC</b><small>항상 표시</small></span>
      : <button className="fl-location-option" aria-pressed={scope.current.origin === 'local'} onClick={() => scope.select(local?.id ?? 'local', 'local')}><AppIcon name="monitor" size={16} /><b>내 PC</b></button>)}
    <div className="fl-location-server" data-selected={combined || scope.current.origin === 'server'}>
      {combined ? <span><AppIcon name="database" size={16} />서버</span> : <button aria-pressed={scope.current.origin === 'server'} onClick={() => chooseServer(selectedServerId)} disabled={!scope.connected}><AppIcon name="database" size={16} />서버</button>}
      <select aria-label={combined ? '표시할 서버 공간' : '서버 저장 공간'} value={selectedServerId} onChange={event => chooseServer(event.target.value)} disabled={!scope.connected}>
        {combined && <option value="">모든 서버 공간</option>}
        {selectedServerId && !servers.some(workspace => workspace.id === selectedServerId) && <option value={selectedServerId}>{selectedServerId === 'public' ? '공용' : '선택한 공간'}{scope.remoteLoading ? ' · 불러오는 중' : ''}</option>}
        {servers.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.kind === 'PUBLIC' ? '공용' : workspace.name}{workspace.myRole === 'VIEWER' ? ' · 읽기 전용' : ''}</option>)}
      </select>
    </div>
    {!scope.connected && <small className="fl-location-connection">서버 로그인 필요</small>}
    <Link to="/workspaces" className="fl-location-browse">공간 탐색<AppIcon name="arrowRight" size={14} /></Link>
  </div>
}
