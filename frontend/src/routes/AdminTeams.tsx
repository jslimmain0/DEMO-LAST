import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useApi } from '../app/WorkspaceContext'
import type { AdminUserView, AdminWorkspaceView } from '../api/client'
import { AskDialog, type AskSpec } from '../components/AskDialog'
import { CatalogPagination } from '../components/CatalogPagination'
import { Modal } from '../components/Modal'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { catalogPage, matchesCatalog } from '../lib/catalog'

const roles = { OWNER: '팀 관리자', EDITOR: '편집자', VIEWER: '조회자' }
type TeamRole = keyof typeof roles

export function AdminTeams({ users, teams, personals, publicFlowCount, publicMockCount, loading, onRefresh }: { users: AdminUserView[]; teams: AdminWorkspaceView[]; personals: AdminWorkspaceView[]; publicFlowCount: number; publicMockCount: number; loading: boolean; onRefresh: () => void }) {
  const { workspacesApi } = useApi()
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('TEAM')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [selected, setSelected] = useState<string | null>(null)
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const create = useMutation({ mutationFn: workspacesApi.create, onSuccess: workspace => { onRefresh(); setSelected(workspace.id); toast(`팀 ${workspace.name}을 만들었습니다.`, 'ok') }, onError: error => toast(apiErrorMessage(error), 'error') })
  const remove = useMutation({ mutationFn: (workspace: AdminWorkspaceView) => workspacesApi.remove(workspace.id), onSuccess: (_value, workspace) => { onRefresh(); toast(`빈 공간 ${workspace.name}을 삭제했습니다.`, 'ok') }, onError: error => toast(apiErrorMessage(error), 'error') })
  const filtered = (kind === 'TEAM' ? teams : personals).filter(workspace => matchesCatalog(search, [workspace.name, workspace.id, workspace.ownerUsername, ...workspace.members.map(member => member.username)])).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
  const range = catalogPage(filtered.length, page, size)
  const selectedWorkspace = teams.find(workspace => workspace.id === selected)
  return <section aria-label="팀과 공간 권한 관리">
    <p className="fl-admin-note">공용 공간: 워크플로 {publicFlowCount}개 · Mock {publicMockCount}개. 공용 공간은 팀 멤버십으로 접근을 제한하지 않습니다. 접근을 제한할 작업은 팀에 저장하세요.</p>
    <div className="fl-admin-toolbar"><input type="search" aria-label="관리할 공간 또는 멤버 검색" placeholder="공간 이름·ID·멤버 검색" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><label>목록<select value={kind} onChange={event => { setKind(event.target.value); setPage(1) }}><option value="TEAM">팀 ({teams.length})</option><option value="PERSONAL">서버에 남은 개인 공간 ({personals.length})</option></select></label><button disabled={create.isPending} onClick={() => setAsk({ title: '새 팀 공간', input: { label: '팀 이름', placeholder: '예: 결제팀' }, confirmLabel: '팀 만들기', onConfirm: name => create.mutate(name) })}>＋ 새 팀</button></div>
    {kind === 'PERSONAL' && <p className="fl-admin-note">이 목록은 서버 DB의 기존 개인 공간입니다. 사용자 PC의 개인 H2 데이터는 서버 관리자가 조회하거나 삭제할 수 없습니다.</p>}
    <CatalogPagination total={filtered.length} page={range.page} size={size} onPage={setPage} onSize={next => { setSize(next); setPage(1) }} label="관리 공간" />
    <div className="fl-admin-table"><table><thead><tr><th>공간</th><th>멤버</th><th>워크플로</th><th>Mock</th><th>작업</th></tr></thead><tbody>{filtered.slice(range.start, range.end).map(workspace => <tr key={workspace.id}><td><b>{workspace.name}</b><small>ID · {workspace.id.slice(0, 8)}{workspace.ownerUsername ? ` · 소유자 ${workspace.ownerUsername}` : ''}</small></td><td>{workspace.members.length}명</td><td>{workspace.flowCount}</td><td>{workspace.mockCount}</td><td><div className="fl-admin-row-actions">{workspace.kind === 'TEAM' && <button onClick={() => setSelected(workspace.id)} aria-label={`${workspace.name} 멤버와 권한 관리`}>멤버·권한 관리</button>}<button disabled={remove.isPending || workspace.flowCount > 0 || workspace.mockCount > 0} onClick={() => setAsk({ title: '빈 공간 삭제', message: `${workspace.name} · ${workspace.id}. 공간과 멤버십을 삭제합니다. 다른 자원이 남아 있으면 서버에서 삭제를 거부할 수 있습니다.`, danger: true, confirmLabel: '빈 공간 삭제', onConfirm: () => remove.mutate(workspace) })}>빈 공간 삭제</button></div>{(workspace.flowCount > 0 || workspace.mockCount > 0) && <small>자원이 있어 삭제 불가</small>}</td></tr>)}{!filtered.length && <tr><td colSpan={5}>{loading ? '공간을 불러오는 중입니다.' : search ? '검색 조건에 맞는 공간이 없습니다.' : '이 종류의 공간이 없습니다.'}</td></tr>}</tbody></table></div>
    {selectedWorkspace && <TeamEditor key={selectedWorkspace.id} workspace={selectedWorkspace} users={users} onClose={() => setSelected(null)} onRefresh={onRefresh} />}
    {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
  </section>
}

function TeamEditor({ workspace, users, onClose, onRefresh }: { workspace: AdminWorkspaceView; users: AdminUserView[]; onClose: () => void; onRefresh: () => void }) {
  const { workspacesApi } = useApi()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [candidateSearch, setCandidateSearch] = useState('')
  const [pick, setPick] = useState('')
  const [role, setRole] = useState<TeamRole>('EDITOR')
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const put = useMutation({ mutationFn: (request: { username: string; role: string }) => workspacesApi.putMember(workspace.id, request.username, request.role), onSuccess: (_value, request) => { onRefresh(); setPick(''); toast(`${request.username} · ${workspace.name}의 권한을 저장했습니다.`, 'ok') }, onError: error => toast(apiErrorMessage(error), 'error') })
  const remove = useMutation({ mutationFn: (username: string) => workspacesApi.removeMember(workspace.id, username), onSuccess: (_value, username) => { onRefresh(); toast(`${username}을 ${workspace.name}에서 제외했습니다.`, 'ok') }, onError: error => toast(apiErrorMessage(error), 'error') })
  const busy = put.isPending || remove.isPending
  const owners = workspace.members.filter(member => member.role === 'OWNER').length
  const filtered = workspace.members.filter(member => matchesCatalog(search, [member.username, member.role, roles[member.role]])).sort((a, b) => a.username.localeCompare(b.username))
  const range = catalogPage(filtered.length, page, 10)
  const candidates = users.filter(user => !workspace.members.some(member => member.username === user.username) && user.status !== 'BLOCKED' && !['dev', 'guest'].includes(user.username))
  const matchedCandidates = candidates.filter(user => matchesCatalog(candidateSearch, [user.username])).sort((a, b) => a.username.localeCompare(b.username)).slice(0, 100)
  const selectedCandidate = candidates.find(user => user.username === pick)
  const shownCandidates = selectedCandidate && !matchedCandidates.some(user => user.username === pick) ? [selectedCandidate, ...matchedCandidates] : matchedCandidates
  const confirmRole = (username: string, previous: TeamRole, next: TeamRole) => {
    if (next === previous) return
    setAsk({ title: '팀 권한 변경', message: `${workspace.name} · ${username}: ${roles[previous]} → ${roles[next]}. 이 팀에만 적용되며 전역 권한은 바뀌지 않습니다.`, danger: next === 'OWNER', confirmLabel: '권한 변경 적용', onConfirm: () => put.mutate({ username, role: next }) })
  }
  return <Modal onClose={onClose} ariaLabel={`${workspace.name} 멤버와 권한 관리`} width={900} card={{ padding: 20, overflowY: 'auto' }}><section className="fl-admin fl-admin-dialog">
    <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16 }}><div><h2 style={{ fontSize: 17, margin: '0 0 6px' }}>{workspace.name} · 멤버와 권한</h2><p className="fl-admin-note">ID · {workspace.id}<br />팀 관리자 {owners}명 · 마지막 팀 관리자는 제외하거나 강등할 수 없습니다.</p></div><button onClick={onClose}>닫기</button></div>
    <div className="fl-admin-toolbar"><input type="search" aria-label="현재 팀 멤버 또는 권한 검색" placeholder="현재 멤버·권한 검색" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
    <CatalogPagination total={filtered.length} page={range.page} size={10} onPage={setPage} label="팀 멤버" />
    <div className="fl-admin-table"><table><thead><tr><th>사용자</th><th>가입 상태</th><th>이 팀의 권한</th><th>작업</th></tr></thead><tbody>{filtered.slice(range.start, range.end).map(member => {
      const status = users.find(user => user.username === member.username)?.status
      const lastOwner = member.role === 'OWNER' && owners <= 1
      return <tr key={member.username}><td><b>{member.username}</b></td><td>{status === 'BLOCKED' ? '차단됨' : status === 'PENDING' ? '가입 대기' : status === 'APPROVED' ? '승인됨' : '확인 안 됨'}</td><td><select value={member.role} disabled={busy} aria-label={`${member.username}의 ${workspace.name} 권한`} onChange={event => confirmRole(member.username, member.role, event.target.value as TeamRole)}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value} disabled={lastOwner && value !== 'OWNER'}>{label}</option>)}</select>{lastOwner && <small>마지막 팀 관리자</small>}</td><td><button disabled={busy || lastOwner} onClick={() => setAsk({ title: '팀에서 사용자 제외', message: `${workspace.name} · ${member.username}의 이 팀 접근 권한을 제거합니다. 계정과 다른 팀 권한은 유지됩니다.`, danger: true, confirmLabel: '팀에서 제외', onConfirm: () => remove.mutate(member.username) })}>팀에서 제외</button></td></tr>
    })}{!filtered.length && <tr><td colSpan={4}>조건에 맞는 팀 멤버가 없습니다.</td></tr>}</tbody></table></div>
    <h3 style={{ fontSize: 14, marginBottom: 8 }}>팀 멤버 추가</h3><div className="fl-admin-add-member"><label>추가할 사용자 검색<input type="search" aria-label="추가할 사용자 검색" placeholder="사용자 이름 검색" value={candidateSearch} onChange={event => setCandidateSearch(event.target.value)} /></label><label>사용자<select value={pick} disabled={busy} aria-label="추가할 사용자 선택" onChange={event => setPick(event.target.value)}><option value="">사용자 선택</option>{shownCandidates.map(user => <option key={user.username} value={user.username}>{user.username}{user.status === 'PENDING' ? ' · 가입 대기' : ''}</option>)}</select></label><label>이 팀의 권한<select value={role} disabled={busy} aria-label="새 멤버의 팀 권한" onChange={event => setRole(event.target.value as TeamRole)}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button disabled={busy || !selectedCandidate} onClick={() => { if (!selectedCandidate) return; setAsk({ title: '팀 멤버 추가', message: `${workspace.name}에 ${selectedCandidate.username}을 ${roles[role]}로 추가합니다.${selectedCandidate.status === 'PENDING' ? ' 가입 대기 상태는 유지되지만 팀 멤버십에 따라 이 팀에 접근할 수 있습니다.' : ''}`, confirmLabel: '멤버 추가', onConfirm: () => put.mutate({ username: selectedCandidate.username, role }) }) }}>멤버 추가</button></div>
    <p className="fl-admin-note">추가 가능한 사용자 {candidates.length}명 · 검색 후 최대 100명 표시. 차단된 계정은 추가할 수 없습니다.</p>
    {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
  </section></Modal>
}
