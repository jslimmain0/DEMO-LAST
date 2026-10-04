import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthContext'
import { desktopApi } from '../auth/desktop'
import { AskDialog, type AskSpec } from '../components/AskDialog'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { useWorkspace, type WorkspaceRef } from '../app/WorkspaceContext'
import { AppShellTier1 } from '../app/AppShell'
import { matchesCatalog, catalogPage } from '../lib/catalog'
import { CatalogPagination } from '../components/CatalogPagination'
import { readWorkspaceNavigation, visitWorkspace, workspaceIdentity, workspaceStorageKey } from '../lib/workspaceNavigation'

export function Workspaces() {
  const scope = useWorkspace()
  const { desktop, me } = useAuth()
  const connection = useQuery({ queryKey: ['desktop', 'connection'], queryFn: desktopApi.connection, enabled: !!desktop })
  const server = scope.agentApi('server')
  const membership = useQuery({ queryKey: ['server-membership', scope.remoteKey], queryFn: server.adminApi.me, enabled: scope.connected, retry: false })
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const createTeam = useMutation({ mutationFn: server.workspacesApi.create, onSuccess: w => { scope.refresh(); scope.select(w.id, 'server'); toast('팀 공간을 만들었습니다.', 'ok') }, onError: e => toast(apiErrorMessage(e), 'error') })
  const serverUrl = connection.data?.serverUrl ?? desktop?.serverUrl ?? window.location.origin
  let serverHost = serverUrl
  try { serverHost = new URL(serverUrl).host } catch { /* display configured address */ }
  const create = () => setAsk({ title: '새 팀 공간', message: `팀 작업은 ${serverHost}에 저장됩니다.`, input: { label: '팀 공간 이름', placeholder: '예: 결제팀' }, confirmLabel: '만들기', onConfirm: name => createTeam.mutate(name) })
  const key = workspaceStorageKey(scope.remoteKey)
  const [favorites, setFavorites] = useState(() => readWorkspaceNavigation(key).favorites)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [requestedPage, setPage] = useState(1)
  const [size, setSize] = useState(50)
  const recent = readWorkspaceNavigation(key).recent
  const personal = scope.workspaces.filter(w => w.origin === 'local')
  const spaces = scope.workspaces.filter(w => w.origin === 'server' && matchesCatalog(search, [w.name, w.id]) && (filter === 'all' || filter === 'favorites' && favorites.includes(workspaceIdentity(w)) || filter === 'recent' && recent.includes(workspaceIdentity(w)) || filter === 'team' && w.kind === 'TEAM' || filter === 'public' && w.kind === 'PUBLIC'))
    .sort((a, b) => filter === 'recent' ? recent.indexOf(workspaceIdentity(a)) - recent.indexOf(workspaceIdentity(b)) : a.name.localeCompare(b.name, 'ko', { numeric: true }))
  const page = catalogPage(spaces.length, requestedPage, size)
  const choose = (w: WorkspaceRef) => { visitWorkspace(key, w); scope.select(w.id, w.origin) }
  const favorite = (w: WorkspaceRef) => {
    const id = workspaceIdentity(w)
    const next = favorites.includes(id) ? favorites.filter(x => x !== id) : [...favorites, id]
    setFavorites(next)
    try { localStorage.setItem(key, JSON.stringify({ ...readWorkspaceNavigation(key), favorites: next })) } catch { /* private mode */ }
  }
  const row = (w: WorkspaceRef) => <tr key={workspaceIdentity(w)}>
    <td><button className="fl-space-star" aria-label={`${w.name} 즐겨찾기 ${favorites.includes(workspaceIdentity(w)) ? '해제' : '추가'}`} aria-pressed={favorites.includes(workspaceIdentity(w))} onClick={() => favorite(w)}>{favorites.includes(workspaceIdentity(w)) ? '★' : '☆'}</button></td>
    <td><button className="fl-space-open" aria-label={`${w.name} · ${w.id} 열기`} onClick={() => choose(w)}><b>{w.name}</b><small title={w.id}>ID · {w.id.slice(0, 8)}</small></button></td>
    <td><span className={`fl-location-chip ${w.origin}`}>{w.origin === 'local' ? '내 PC' : w.kind === 'PUBLIC' ? '서버 · 공용' : '서버 · 팀'}</span></td>
    <td>{w.myRole === 'OWNER' ? '관리자' : w.myRole === 'EDITOR' ? '편집 가능' : '읽기 전용'}</td>
    <td>{workspaceIdentity(w) === workspaceIdentity(scope.current) ? <span className="fl-space-active">현재 공간</span> : <button className="fl-workbench-button" onClick={() => choose(w)}>열기 →</button>}</td>
  </tr>
  return <AppShellTier1>
    <div className="fl-workbench-page fl-workspace-library">
      <header className="fl-workbench-title"><div><h1>공간 탐색</h1><span>내 PC의 개인 작업과 회사 서버의 팀 작업을 찾아 엽니다.</span></div><button className="fl-workbench-button" onClick={scope.refresh}>목록 새로고침</button></header>
      {personal.length > 0 && <section className="fl-personal-space"><div><h2>내 PC의 개인 공간</h2><p>서버 로그인과 관계없이 이 PC에 저장됩니다.</p></div><div>{personal.map(w => <button key={w.id} onClick={() => choose(w)}><b>{w.name}</b><span>개인 작업 열기 →</span></button>)}</div></section>}
      <section aria-labelledby="server-spaces-title"><div className="fl-library-heading"><div><h2 id="server-spaces-title">회사 서버의 공용·팀 공간</h2><span>{serverHost} · {scope.connected ? `${scope.login ?? me?.username ?? '사용자'} 로그인` : '로그인 필요'}</span></div>{scope.connected && membership.data?.myStatus === 'APPROVED' && <button className="fl-workbench-button" disabled={createTeam.isPending} onClick={create}>{createTeam.isPending ? '만드는 중…' : '＋ 새 팀 공간'}</button>}</div>
        {!scope.connected && <p className="fl-library-guide">서버 로그인 후 회사의 공용·팀 공간을 엽니다. 개인 작업은 계속 내 PC에 저장됩니다.</p>}
        {scope.connected && membership.data?.myStatus === 'PENDING' && <p className="fl-library-guide" role="status">가입 신청이 접수됐습니다. 관리자가 승인하면 팀 공간을 이용할 수 있습니다.</p>}
        {scope.connected && membership.data?.myStatus === 'BLOCKED' && <p className="fl-library-guide" role="status">서버 계정 사용이 제한돼 있습니다. 회사 FlowLink 관리자에게 문의하세요.</p>}
        {scope.connected && membership.data?.myStatus === 'APPROVED' && !scope.workspaces.some(w => w.origin === 'server' && w.kind === 'TEAM') && <p className="fl-library-guide">아직 참여 중인 팀 공간이 없습니다. 기존 팀 관리자에게 멤버 추가를 요청하거나 새 팀 공간을 만드세요.</p>}
        {scope.connected && membership.isError && <p className="fl-library-guide" role="alert">가입 상태를 확인하지 못했습니다. <button className="fl-workbench-button" onClick={() => void membership.refetch()}>다시 확인</button></p>}
        <div className="fl-library-toolbar"><div className="fl-library-filters" role="group" aria-label="공간 분류">{[['all', '전체'], ['favorites', '즐겨찾기'], ['recent', '최근'], ['team', '팀'], ['public', '공용']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(1) }}>{label}</button>)}</div><input aria-label="서버 공간 검색" placeholder="공간 이름 또는 ID 검색" value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} /></div>
        <CatalogPagination total={spaces.length} page={page.page} size={size} onPage={setPage} onSize={n => { setSize(n); setPage(1) }} label="공간" />
        <div className="fl-library-table fl-table-wrap"><table className="fl-table"><thead><tr><th aria-label="즐겨찾기" /><th>공간 이름</th><th>저장 위치</th><th>내 권한</th><th>작업</th></tr></thead><tbody>{spaces.slice(page.start, page.end).map(row)}</tbody></table></div>
        {!spaces.length && <p className="fl-library-empty" role="status">{scope.connected && scope.remoteLoading ? '공간 목록을 불러오는 중입니다.' : !scope.connected ? '사이드바의 서버 로그인으로 연결하세요.' : '조건에 맞는 공간이 없습니다. 검색어나 분류를 바꿔보세요.'}</p>}
        {scope.remoteError && <p role="alert">서버 공간 목록을 갱신하지 못했습니다. 연결 후 다시 시도하세요.</p>}
      </section>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </div>
  </AppShellTier1>
}
