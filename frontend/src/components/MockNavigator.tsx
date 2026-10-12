import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { useWorkspace } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { AppIcon } from './AppIcon'
import { apiErrorMessage } from '../lib/apiError'
import { useCatalogNavigation } from '../lib/useCatalogNavigation'
import './mock-navigator.css'

export function MockNavigator() {
  const scope = useWorkspace()
  const { agentApi } = scope
  const { desktop } = useAuth()
  const { id } = useParams()
  const navigate = useNavigate()
  const catalog = useCatalogNavigation('mocks')
  const [search, setSearch] = useState('')
  const localId = scope.workspaces.find(w => w.origin === 'local')?.id ?? 'local'
  const local = useMemo(() => agentApi('local', localId), [agentApi, localId])
  const remote = useMemo(() => agentApi('server', 'public'), [agentApi])
  const pc = useQuery({ queryKey: ['mock-explorer', 'local', localId], queryFn: local.mocksApi.fleet, enabled: !!desktop, refetchInterval: 5000, retry: false })
  const server = useQuery({ queryKey: ['mock-explorer', 'server', scope.remoteKey], queryFn: remote.mocksApi.fleet, enabled: scope.connected, refetchInterval: 5000, retry: false })
  return <div className="fl-mock-explorer" aria-label="Mock 탐색">
    <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Mock 찾아보기" aria-label="Mock 탐색 검색" />
    {([['local', '내 PC', pc], ['server', '서버', server]] as const).map(([origin, label, query]) => {
      const available = origin === 'local' ? !!desktop : scope.connected
      const items = (query.data?.servers ?? []).filter(s => s.readable && (!search || `${s.name} ${s.slug}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())))
      return <section key={origin} className="fl-mock-explorer-group" aria-label={`${label} Mock 탐색`}>
        <div className="fl-mock-explorer-heading"><AppIcon name={origin === 'local' ? 'monitor' : 'server'} size={13} /><strong>{label}</strong><span>{items.length}</span></div>
        {!available ? <p>{origin === 'local' ? 'PC 앱에서 사용할 수 있습니다.' : '서버에 연결하면 목록이 표시됩니다.'}</p> : query.isError ? <p role="alert">{apiErrorMessage(query.error)} <button onClick={() => void query.refetch()}>다시 확인</button></p> : query.isPending ? <p>목록을 불러오는 중…</p> : !items.length ? <p>{search ? '일치하는 Mock이 없습니다.' : '아직 Mock이 없습니다.'}</p> : <div className="fl-mock-explorer-items">{items.map(s => <button key={s.id} aria-current={scope.current.origin === origin && id === s.id ? 'page' : undefined} title={`${s.name} · ${s.slug}`} onClick={() => { const link = catalog.detail(s.id, { origin, id: s.workspaceId }); navigate(link.to, { state: link.state }) }}><AppIcon name={s.kind === 'TCP' ? 'link' : 'globe'} size={13} /><span>{s.name}</span><i data-enabled={s.enabled} aria-label={s.enabled ? '켜짐' : '꺼짐'} /></button>)}</div>}
      </section>
    })}
  </div>
}
