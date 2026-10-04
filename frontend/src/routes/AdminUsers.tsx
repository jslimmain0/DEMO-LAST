import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useApi } from '../app/WorkspaceContext'
import type { AdminUserView, AdminWorkspaceView } from '../api/client'
import { AskDialog, type AskSpec } from '../components/AskDialog'
import { CatalogPagination } from '../components/CatalogPagination'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { catalogPage, matchesCatalog } from '../lib/catalog'
import { relTime } from '../lib/format'
import { Modal } from '../components/Modal'

export function AdminUsers({ myName, users, teams, loading, onRefresh, onBusyChange }: { myName: string; users: AdminUserView[]; teams: AdminWorkspaceView[]; loading: boolean; onRefresh: () => void; onBusyChange: (busy: boolean) => void }) {
  const { adminApi } = useApi()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all')
  const [role, setRole] = useState('all')
  const [sort, setSort] = useState('name')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ success: number; failed: string[] } | null>(null)
  const [membershipUser, setMembershipUser] = useState<string | null>(null)
  const membership = useMemo(() => {
    const result = new Map<string, Array<{ name: string; role: string; id: string }>>()
    for (const team of teams) for (const member of team.members) result.set(member.username, [...(result.get(member.username) ?? []), { name: team.name, role: member.role, id: team.id }])
    return result
  }, [teams])
  const filtered = users.filter(user => (status === 'all' || user.status === status) && (role === 'all' || user.globalRole === role) && matchesCatalog(q, [user.username, ...(membership.get(user.username) ?? []).map(team => team.name)]))
    .sort((a, b) => sort === 'recent' ? (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || a.username.localeCompare(b.username) : a.username.localeCompare(b.username, 'ko', { numeric: true }))
  const range = catalogPage(filtered.length, page, size)
  const shown = filtered.slice(range.start, range.end)
  const targets = users.filter(user => user.status === 'PENDING' && user.username !== myName && selected.has(user.username))
  const shownPending = shown.filter(user => user.status === 'PENDING' && user.username !== myName)
  const hidden = targets.filter(user => !shown.some(item => item.username === user.username)).length
  const change = useMutation({ mutationFn: (request: { username: string; body: { status?: string; globalRole?: string } }) => adminApi.putUser(request.username, request.body), onSuccess: (_data, request) => { onRefresh(); toast(`${request.username}의 설정을 저장했습니다.`, 'ok') }, onError: error => toast(apiErrorMessage(error), 'error') })
  const remove = useMutation({ mutationFn: adminApi.removeUser, onSuccess: (_data, username) => { onRefresh(); toast(`${username}의 계정과 팀 멤버십을 제거했습니다. 원격 데이터는 보존됩니다. 담당 팀은 남으며 다른 전역 관리자가 관리합니다.`, 'ok') }, onError: error => toast(apiErrorMessage(error), 'error') })
  const busy = bulkBusy || change.isPending || remove.isPending
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false) }, [busy, onBusyChange])
  const approveSelected = async (names: string[]) => {
    setBulkBusy(true); setBulkResult(null)
    const failed: string[] = []
    let success = 0
    for (const username of names) {
      try { await adminApi.putUser(username, { status: 'APPROVED' }); success++ }
      catch { failed.push(username) }
    }
    setSelected(new Set(failed)); setBulkResult({ success, failed }); setBulkBusy(false); onRefresh()
    toast(`승인 성공 ${success}명 · 실패 ${failed.length}명`, failed.length ? 'error' : 'ok')
  }
  const confirmChange = (user: AdminUserView, body: { status?: string; globalRole?: string }, title: string, message: string) => setAsk({ title, message: `${user.username} · ${message}`, confirmLabel: '변경 적용', danger: body.status === 'BLOCKED' || body.globalRole === 'ADMIN', onConfirm: () => change.mutate({ username: user.username, body }) })
  const toggle = (name: string) => setSelected(previous => { const next = new Set(previous); if (next.has(name)) next.delete(name); else next.add(name); return next })
  const roleName = (value: string) => value === 'ADMIN' ? '전역 관리자' : '일반 사용자'
  return <section aria-label="사용자 관리">
    <p className="fl-admin-note">가입 승인은 팀 생성과 AI 사용을 허용합니다. 팀 접근 권한은 멤버십에서 별도로 설정하며, 가입 대기 사용자도 팀에 추가할 수 있습니다.</p>
    <div className="fl-admin-toolbar">
      <input type="search" aria-label="사용자 또는 소속 팀 검색" placeholder="사용자 또는 소속 팀 검색" value={q} onChange={event => { setQ(event.target.value); setPage(1) }} />
      <label>상태<select value={status} onChange={event => { setStatus(event.target.value); setPage(1) }}><option value="all">전체 ({users.length})</option><option value="PENDING">가입 대기 ({users.filter(user => user.status === 'PENDING').length})</option><option value="APPROVED">승인됨</option><option value="BLOCKED">차단됨</option></select></label>
      <label>전역 권한<select value={role} onChange={event => { setRole(event.target.value); setPage(1) }}><option value="all">전체</option><option value="ADMIN">관리자</option><option value="MEMBER">일반 사용자</option></select></label>
      <label>정렬<select value={sort} onChange={event => { setSort(event.target.value); setPage(1) }}><option value="name">이름순</option><option value="recent">최근 접속순</option></select></label>
    </div>
    <div className="fl-admin-selection">
      <button disabled={busy || !shownPending.length} onClick={() => setSelected(previous => new Set([...previous, ...shownPending.map(user => user.username)]))}>현재 페이지의 가입 대기 선택 ({shownPending.length})</button>
      <span role="status">선택 {targets.length}명{hidden ? ` · 현재 페이지 밖 ${hidden}명 포함` : ''}</span>
      <button disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>선택 해제</button>
      <button disabled={busy || !targets.length} onClick={() => { const names = targets.map(user => user.username); setAsk({ title: `선택한 가입 신청 ${names.length}명 승인`, message: `${names.slice(0, 8).join(', ')}${names.length > 8 ? ` 외 ${names.length - 8}명` : ''}${hidden ? ` · 페이지 밖 ${hidden}명 포함` : ''}. 선택한 신청만 승인하며, 팀에는 자동으로 추가하지 않습니다.`, confirmLabel: `${names.length}명 승인`, onConfirm: () => void approveSelected(names) }) }}>{bulkBusy ? '승인 처리 중…' : '선택한 신청 승인'}</button>
    </div>
    {bulkResult && <p role={bulkResult.failed.length ? 'alert' : 'status'} className="fl-admin-note">승인 성공 {bulkResult.success}명 · 실패 {bulkResult.failed.length}명{bulkResult.failed.length > 0 && <> — {bulkResult.failed.join(', ')}. 실패한 신청은 선택을 유지했습니다.</>}</p>}
    <CatalogPagination total={filtered.length} page={range.page} size={size} onPage={setPage} onSize={next => { setSize(next); setPage(1) }} label="사용자" />
    <div className="fl-admin-table"><table><thead><tr><th>선택</th><th>사용자</th><th>상태</th><th>전역 권한</th><th>소속 팀</th><th>최근 접속</th><th>작업</th></tr></thead><tbody>
      {shown.map(user => <tr key={user.username}>
        <td>{user.status === 'PENDING' && user.username !== myName && <input type="checkbox" aria-label={`${user.username} 가입 승인 대상으로 선택`} disabled={busy} checked={selected.has(user.username)} onChange={() => toggle(user.username)} />}</td>
        <td><b>{user.username}</b>{user.username === myName && <small>내 계정</small>}<small>가입 {user.createdAt ? relTime(user.createdAt) : '—'}</small></td>
        <td>{user.status === 'PENDING' ? '가입 대기' : user.status === 'BLOCKED' ? '차단됨' : '승인됨'}</td>
        <td><button disabled={busy || user.username === myName} title={user.username === myName ? '자신의 전역 권한은 변경할 수 없습니다.' : undefined} onClick={() => { const next = user.globalRole === 'ADMIN' ? 'MEMBER' : 'ADMIN'; confirmChange(user, { globalRole: next }, '전역 권한 변경', `${roleName(user.globalRole)} → ${roleName(next)}. 전역 관리자는 모든 공간과 이 관리 화면에 접근할 수 있습니다.`) }}>{roleName(user.globalRole)} · 변경</button></td>
        <td><button disabled={!membership.get(user.username)?.length} onClick={() => setMembershipUser(user.username)} aria-label={`${user.username} 소속 ${membership.get(user.username)?.length ?? 0}개 팀 보기`}>소속 {membership.get(user.username)?.length ?? 0}개 팀 보기</button></td>
        <td>{user.lastSeenAt ? relTime(user.lastSeenAt) : '접속 기록 없음'}</td>
        <td><div className="fl-admin-row-actions">{user.username !== myName && <>
          {user.status !== 'APPROVED' && <button disabled={busy} onClick={() => confirmChange(user, { status: 'APPROVED' }, user.status === 'BLOCKED' ? '계정 차단 해제' : '가입 승인', '가입을 승인해 팀 생성과 AI 사용을 허용합니다. 팀 접근 권한은 별도입니다.')}>{user.status === 'BLOCKED' ? '차단 해제' : '승인'}</button>}
          {user.status !== 'BLOCKED' && <button disabled={busy} onClick={() => confirmChange(user, { status: 'BLOCKED' }, '계정 차단', '서버 로그인이 거부됩니다. 기존 데이터는 보존합니다.')}>차단</button>}
          <button disabled={busy} onClick={() => setAsk({ title: '사용자 삭제', message: `${user.username}의 계정과 팀 멤버십을 제거합니다. 원격 데이터는 보존됩니다. 담당 팀은 남으며 다른 전역 관리자가 관리합니다.`, danger: true, confirmLabel: '사용자 삭제', onConfirm: () => remove.mutate(user.username) })}>삭제</button>
        </>}</div></td>
      </tr>)}
      {!shown.length && <tr><td colSpan={7}>{loading ? '사용자를 불러오는 중입니다.' : users.length ? '조건에 맞는 사용자가 없습니다.' : '등록된 사용자가 없습니다.'}</td></tr>}
    </tbody></table></div>
    <p className="fl-admin-note">전역 관리자는 모든 공간을 관리합니다. 팀의 관리자·편집자·조회자는 해당 팀에만 적용됩니다. 내 계정의 전역 권한과 상태는 여기서 변경할 수 없습니다.</p>
    {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    {membershipUser && <UserMembership key={membershipUser} name={membershipUser} teams={membership.get(membershipUser) ?? []} onClose={() => setMembershipUser(null)} />}
  </section>
}

function UserMembership({ name, teams, onClose }: { name: string; teams: Array<{ id: string; name: string; role: string }>; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const filtered = teams.filter(team => matchesCatalog(search, [team.name, team.id, team.role])).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
  const range = catalogPage(filtered.length, page, 10)
  return <Modal ariaLabel={`${name}의 소속 팀`} onClose={onClose} width={760} card={{ padding: 20, overflowY: 'auto' }}><div className="fl-admin fl-admin-dialog">
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><h2 style={{ margin: 0, fontSize: 16 }}>{name}의 소속 팀</h2><button onClick={onClose}>닫기</button></div>
    <div className="fl-admin-toolbar"><input autoFocus type="search" aria-label="소속 팀 이름 또는 ID 검색" placeholder="팀 이름·ID·권한 검색" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
    <CatalogPagination total={filtered.length} page={range.page} size={10} onPage={setPage} label="소속 팀" />
    <div className="fl-admin-table"><table><thead><tr><th>팀</th><th>권한</th></tr></thead><tbody>{filtered.slice(range.start, range.end).map(team => <tr key={team.id}><td><b>{team.name}</b><small>ID · {team.id}</small></td><td>{team.role === 'OWNER' ? '팀 관리자' : team.role === 'EDITOR' ? '편집자' : '조회자'}</td></tr>)}{!filtered.length && <tr><td colSpan={2}>조건에 맞는 소속 팀이 없습니다.</td></tr>}</tbody></table></div>
  </div></Modal>
}
