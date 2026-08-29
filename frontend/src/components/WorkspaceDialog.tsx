import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { adminApi, workspacesApi } from '../api/client'
import type { WorkspaceView } from '../api/client'
import { Modal } from './Modal'
import { toast } from './toast'

/**
 * 워크스페이스 관리 다이얼로그 — [멤버] 현재 워크스페이스의 멤버·롤(OWNER 만 편집),
 * [사용자] 전역 사용자 레지스트리/전역 롤(ADMIN 만). 공용 워크스페이스는 멤버 개념이 없어 안내만.
 */
export function WorkspaceDialog({ current, onClose, onDeleted }: {
  current: WorkspaceView
  onClose: () => void
  onDeleted: () => void
}) {
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me })
  const [tab, setTab] = useState<'members' | 'users'>('members')
  const isTeam = current.kind === 'TEAM'

  return (
    <Modal onClose={onClose} ariaLabel="워크스페이스 관리" width={640} card={{ padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 20px 12px', borderBottom: '1px solid var(--fl-border)' }}>
        <strong style={{ fontSize: 15 }}>워크스페이스 관리</strong>
        <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>
          {current.kind === 'PUBLIC' ? '🌐' : current.kind === 'PERSONAL' ? '🔒' : '👥'} {current.name}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <button onClick={() => setTab('members')} style={tabBtn(tab === 'members')}>멤버</button>
          {me.data?.admin && <button onClick={() => setTab('users')} style={tabBtn(tab === 'users')}>사용자 (admin)</button>}
          {me.data?.admin && (
            <a href="/admin" style={{ fontSize: 12, color: 'var(--fl-primary)', textDecoration: 'none', fontWeight: 600, marginLeft: 4 }} title="회원·팀·권한 전체 관리">🛡 관리 콘솔 →</a>
          )}
        </div>
        <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
      </div>
      <div style={{ padding: '16px 20px 20px', overflowY: 'auto' }}>
        {tab === 'members' ? (
          current.kind === 'PUBLIC' ? (
            <p style={hint}>공용 워크스페이스는 모두(게스트 포함)가 편집할 수 있는 공유 공간입니다 — 멤버·롤이 없습니다.<br />
              접근을 제한하려면 팀 워크스페이스를 만들어 워크플로를 옮기고 멤버에게 롤(OWNER/EDITOR/VIEWER)을 부여하세요.</p>
          ) : (
            <MembersTab ws={current} isTeam={isTeam} onDeleted={onDeleted} />
          )
        ) : (
          <UsersTab myName={me.data?.username ?? ''} />
        )}
      </div>
    </Modal>
  )
}

const ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const
const roleDesc: Record<string, string> = { OWNER: '관리+편집', EDITOR: '편집', VIEWER: '조회만' }

function MembersTab({ ws, isTeam, onDeleted }: { ws: WorkspaceView; isTeam: boolean; onDeleted: () => void }) {
  const qc = useQueryClient()
  const members = useQuery({ queryKey: ['workspaces', ws.id, 'members'], queryFn: () => workspacesApi.members(ws.id), enabled: isTeam })
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>('EDITOR')
  const [armDelete, setArmDelete] = useState(false) // 삭제 2단계 확인(window.confirm 금지 규약)
  const refresh = () => qc.invalidateQueries({ queryKey: ['workspaces', ws.id, 'members'] })
  const errMsg = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message

  const put = useMutation({
    mutationFn: (v: { username: string; role: string }) => workspacesApi.putMember(ws.id, v.username, v.role),
    onSuccess: () => { refresh(); setName('') },
    onError: (e) => toast(errMsg(e) ?? '멤버 저장에 실패했습니다.', 'error'),
  })
  const remove = useMutation({
    mutationFn: (username: string) => workspacesApi.removeMember(ws.id, username),
    onSuccess: refresh,
    onError: (e) => toast(errMsg(e) ?? '멤버 삭제에 실패했습니다.', 'error'),
  })
  const removeWs = useMutation({
    mutationFn: () => workspacesApi.remove(ws.id),
    onSuccess: () => { toast('워크스페이스를 삭제했습니다 — 안의 워크플로/폴더는 공용으로 이동됨', 'ok'); onDeleted() },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })

  if (!isTeam) {
    return <p style={hint}>개인 워크스페이스는 나만 쓰는 공간입니다(관리자는 열람 가능). 멤버를 추가할 수 없습니다.</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!ws.canManage && <p style={hint}>멤버 편집은 OWNER 만 할 수 있습니다 (내 롤: {ws.myRole}).</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fl-text-muted)', fontSize: 11.5 }}>
            <th style={th}>사용자</th><th style={th}>롤</th><th style={{ ...th, width: 60 }} />
          </tr>
        </thead>
        <tbody>
          {(members.data ?? []).map((m) => (
            <tr key={m.username} style={{ borderTop: '1px solid var(--fl-border)' }}>
              <td style={td}><span style={{ fontFamily: 'var(--fl-font-mono)' }}>{m.username}</span></td>
              <td style={td}>
                {ws.canManage ? (
                  <select value={m.role} onChange={(e) => put.mutate({ username: m.username, role: e.target.value })} style={roleSel}>
                    {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
                  </select>
                ) : (
                  <span>{m.role} <span style={{ color: 'var(--fl-text-muted)' }}>— {roleDesc[m.role]}</span></span>
                )}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>
                {ws.canManage && <button onClick={() => remove.mutate(m.username)} title="내보내기" style={miniDanger}>내보내기</button>}
              </td>
            </tr>
          ))}
          {members.data && members.data.length === 0 && (
            <tr><td colSpan={3} style={{ ...td, color: 'var(--fl-text-muted)' }}>멤버가 없습니다.</td></tr>
          )}
        </tbody>
      </table>
      {ws.canManage && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) put.mutate({ username: name.trim(), role }) }}
            placeholder="GitHub 사용자명"
            aria-label="추가할 사용자명"
            style={nameInput}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="롤" style={roleSel}>
            {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
          </select>
          <button onClick={() => name.trim() && put.mutate({ username: name.trim(), role })} disabled={!name.trim() || put.isPending} style={addBtn}>+ 추가</button>
        </div>
      )}
      {ws.canManage && (
        <div style={{ marginTop: 8, paddingTop: 12, borderTop: '1px dashed var(--fl-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>
            {armDelete ? `"${ws.name}" 을 정말 삭제할까요? 안의 워크플로/폴더는 공용으로 이동됩니다.` : '워크스페이스 삭제 — 안의 워크플로/폴더는 공용으로 이동됩니다.'}
          </span>
          {armDelete ? (
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button onClick={() => setArmDelete(false)} style={cancelMini}>취소</button>
              <button onClick={() => removeWs.mutate()} disabled={removeWs.isPending} style={{ ...miniDanger, background: 'var(--fl-fail)', color: '#fff' }}>정말 삭제</button>
            </span>
          ) : (
            <button onClick={() => setArmDelete(true)} style={{ ...miniDanger, marginLeft: 'auto' }}>워크스페이스 삭제</button>
          )}
        </div>
      )}
    </div>
  )
}

function UsersTab({ myName }: { myName: string }) {
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users })
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] })
  const errMsg = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  const putRole = useMutation({
    mutationFn: (v: { username: string; globalRole: string }) => adminApi.putUser(v.username, v.globalRole),
    onSuccess: refresh,
    onError: (e) => toast(errMsg(e) ?? '변경에 실패했습니다.', 'error'),
  })
  const removeUser = useMutation({
    mutationFn: (username: string) => adminApi.removeUser(username),
    onSuccess: refresh,
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={hint}>로그인했거나 멤버로 추가된 사용자 목록입니다. 전역 ADMIN 은 모든 워크스페이스의 OWNER 격입니다.
        (env <code>FLOWLINK_AUTH_ADMIN_LOGINS</code> 로 부트스트랩 관리자를 지정할 수 있습니다)</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fl-text-muted)', fontSize: 11.5 }}>
            <th style={th}>사용자</th><th style={th}>전역 롤</th><th style={th}>최근 접속</th><th style={{ ...th, width: 50 }} />
          </tr>
        </thead>
        <tbody>
          {(users.data ?? []).map((u) => (
            <tr key={u.username} style={{ borderTop: '1px solid var(--fl-border)' }}>
              <td style={td}><span style={{ fontFamily: 'var(--fl-font-mono)' }}>{u.username}</span>{u.username === myName && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fl-text-muted)' }}>(나)</span>}</td>
              <td style={td}>
                <select value={u.globalRole} onChange={(e) => putRole.mutate({ username: u.username, globalRole: e.target.value })} style={roleSel}>
                  <option value="ADMIN">ADMIN</option>
                  <option value="MEMBER">MEMBER</option>
                </select>
              </td>
              <td style={{ ...td, color: 'var(--fl-text-muted)', fontSize: 12 }}>{u.lastSeenAt ? u.lastSeenAt.slice(0, 16).replace('T', ' ') : '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}>
                {u.username !== myName && <button onClick={() => removeUser.mutate(u.username)} title="레지스트리에서 삭제" style={miniDanger}>삭제</button>}
              </td>
            </tr>
          ))}
          {users.data && users.data.length === 0 && (
            <tr><td colSpan={4} style={{ ...td, color: 'var(--fl-text-muted)' }}>등록된 사용자가 없습니다.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const tabBtn = (on: boolean): CSSProperties => ({
  padding: '6px 12px', border: '1px solid ' + (on ? 'var(--fl-primary)' : 'var(--fl-border)'), borderRadius: 'var(--fl-radius-sm)',
  background: on ? 'color-mix(in srgb, var(--fl-primary) 12%, transparent)' : 'transparent',
  color: on ? 'var(--fl-primary)' : 'var(--fl-text-muted)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
})
const xBtn: CSSProperties = { width: 28, height: 28, border: 'none', borderRadius: 14, background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 18, cursor: 'pointer', lineHeight: 1 }
const hint: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', lineHeight: 1.6, margin: 0 }
const th: CSSProperties = { padding: '4px 8px', fontWeight: 600 }
const td: CSSProperties = { padding: '8px' }
const roleSel: CSSProperties = { padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const nameInput: CSSProperties = { flex: 1, minWidth: 0, padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-bg)', color: 'var(--fl-text)', fontSize: 13 }
const addBtn: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }
const miniDanger: CSSProperties = { padding: '5px 10px', border: '1px solid color-mix(in srgb, var(--fl-fail) 45%, transparent)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const cancelMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
