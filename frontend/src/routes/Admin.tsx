import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { useState } from 'react'
import { adminApi, workspacesApi } from '../api/client'
import type { AdminUserView, AdminWorkspaceView } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { toast } from '../components/toast'
import { relTime } from '../lib/format'

/**
 * 관리 콘솔(/admin) — **관리자 전용** 회원·팀·권한 관리 페이지.
 * [사용자] 전역 롤(ADMIN/MEMBER)·소속 팀·삭제 · [팀·권한] 팀 생성/삭제·멤버 롤(OWNER/EDITOR/VIEWER).
 * 네비는 관리자에게만 노출되고, 백엔드 /admin/* 도 403 으로 이중 방어된다.
 */
export function Admin() {
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 300_000 })
  const [tab, setTab] = useState<'users' | 'teams'>('users')
  const [ask, setAsk] = useState<AskSpec | null>(null)

  if (me.data && !me.data.admin) {
    return (
      <AppShellTier1>
        <div style={{ maxWidth: 700, margin: '80px auto', textAlign: 'center', padding: '0 20px' }}>
          <div style={{ fontSize: 34 }}>🛡</div>
          <h2 style={{ fontFamily: 'var(--fl-font-head)', margin: '12px 0 8px' }}>관리자만 접근할 수 있습니다</h2>
          <p style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, lineHeight: 1.7 }}>
            관리 콘솔은 전역 ADMIN 권한이 필요합니다.<br />
            운영자에게 권한을 요청하거나 env <code>FLOWLINK_AUTH_ADMIN_LOGINS</code> 를 확인하세요.
          </p>
        </div>
      </AppShellTier1>
    )
  }

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1020, margin: '0 auto', padding: '36px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>🛡 관리 콘솔</h1>
          <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>관리자 전용 — 회원 · 팀 · 권한</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button onClick={() => setTab('users')} style={tabBtn(tab === 'users')}>사용자</button>
            <button onClick={() => setTab('teams')} style={tabBtn(tab === 'teams')}>팀 · 권한</button>
          </div>
        </div>

        <div style={{ marginTop: 26 }}>
          {tab === 'users'
            ? <UsersPanel myName={me.data?.username ?? ''} />
            : <TeamsPanel myName={me.data?.username ?? ''} onAsk={setAsk} />}
        </div>
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </AppShellTier1>
  )
}

const ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const
const roleDesc: Record<string, string> = { OWNER: '관리+편집', EDITOR: '편집', VIEWER: '조회만' }
const errMsg = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message

// ─────────────────────────── 사용자 탭 ───────────────────────────

function UsersPanel({ myName }: { myName: string }) {
  const qc = useQueryClient()
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users })
  const wss = useQuery({ queryKey: ['admin', 'workspaces'], queryFn: adminApi.workspaces })
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState<string>('MEMBER')
  const [q, setQ] = useState('')
  const [armDel, setArmDel] = useState<string | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin', 'users'] }); qc.invalidateQueries({ queryKey: ['admin', 'workspaces'] }) }

  const putUser = useMutation({
    mutationFn: (v: { username: string; globalRole: string }) => adminApi.putUser(v.username, v.globalRole),
    onSuccess: () => { refresh(); setNewName('') },
    onError: (e) => toast(errMsg(e) ?? '저장에 실패했습니다.', 'error'),
  })
  const delUser = useMutation({
    mutationFn: (username: string) => adminApi.removeUser(username),
    onSuccess: () => { refresh(); setArmDel(null); toast('사용자를 삭제했습니다(팀 멤버십도 정리).', 'ok') },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })

  // 사용자별 소속 팀 — admin/workspaces 의 멤버 목록에서 역인덱스
  const teamsOf = (username: string): Array<{ name: string; role: string }> =>
    (wss.data?.workspaces ?? [])
      .filter((w) => w.kind === 'TEAM')
      .flatMap((w) => w.members.filter((m) => m.username === username).map((m) => ({ name: w.name, role: m.role })))

  const query = q.trim().toLowerCase()
  const rows = (users.data ?? []).filter((u) => !query || u.username.includes(query))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(users.data?.length ?? 0) >= 6 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="사용자 검색…"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} style={searchBox} />
        )}
        <span style={{ fontSize: 12, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{rows.length}명</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) putUser.mutate({ username: newName.trim(), globalRole: newRole }) }}
            placeholder="GitHub 사용자명" aria-label="추가할 사용자명" style={inputBox}
          />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)} aria-label="전역 롤" style={selBox}>
            <option value="MEMBER">MEMBER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <button onClick={() => newName.trim() && putUser.mutate({ username: newName.trim(), globalRole: newRole })}
            disabled={!newName.trim() || putUser.isPending} style={primaryBtn}>+ 사용자 등록</button>
        </div>
      </div>

      <div style={card}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fl-text-muted)', fontSize: 11.5 }}>
              <th style={th}>사용자</th><th style={th}>전역 롤</th><th style={th}>소속 팀</th><th style={th}>최근 접속</th><th style={{ ...th, width: 110 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((u: AdminUserView) => (
              <tr key={u.username} style={{ borderTop: '1px solid var(--fl-border)' }}>
                <td style={td}>
                  <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 600 }}>{u.username}</span>
                  {u.username === myName && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fl-primary)' }}>(나)</span>}
                </td>
                <td style={td}>
                  <select value={u.globalRole} disabled={u.username === myName}
                    title={u.username === myName ? '자기 자신의 전역 롤은 바꿀 수 없습니다' : undefined}
                    onChange={(e) => putUser.mutate({ username: u.username, globalRole: e.target.value })} style={selBox}>
                    <option value="ADMIN">ADMIN</option>
                    <option value="MEMBER">MEMBER</option>
                  </select>
                </td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {teamsOf(u.username).map((t, i) => (
                      <span key={i} style={teamChip}>{t.name} <b style={{ color: roleColor(t.role) }}>{t.role}</b></span>
                    ))}
                    {teamsOf(u.username).length === 0 && <span style={{ color: 'var(--fl-text-muted)', fontSize: 12 }}>—</span>}
                  </div>
                </td>
                <td style={{ ...td, color: 'var(--fl-text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{u.lastSeenAt ? relTime(u.lastSeenAt) : '—'}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {u.username !== myName && (armDel === u.username ? (
                    <span style={{ display: 'inline-flex', gap: 5 }}>
                      <button onClick={() => setArmDel(null)} style={cancelMini}>취소</button>
                      <button onClick={() => delUser.mutate(u.username)} style={{ ...miniDanger, background: 'var(--fl-fail)', color: '#fff' }}>정말 삭제</button>
                    </span>
                  ) : (
                    <button onClick={() => setArmDel(u.username)} title="레지스트리에서 삭제(팀 멤버십도 정리)" style={miniDanger}>삭제</button>
                  ))}
                </td>
              </tr>
            ))}
            {users.data && rows.length === 0 && (
              <tr><td colSpan={5} style={{ ...td, color: 'var(--fl-text-muted)' }}>{query ? '검색 결과가 없습니다.' : '등록된 사용자가 없습니다. 로그인하거나 위에서 등록하면 나타납니다.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p style={hint}>
        전역 <b>ADMIN</b> 은 모든 워크스페이스의 OWNER 격 + 이 콘솔 접근. env <code>FLOWLINK_AUTH_ADMIN_LOGINS</code> 의 부트스트랩 관리자는
        DB 롤과 무관하게 항상 관리자입니다(dev 모드의 <code>dev</code> 포함). 사용자 등록은 로그인 전에 팀 멤버로 미리 배정할 때 씁니다.
      </p>
    </div>
  )
}

// ─────────────────────────── 팀 · 권한 탭 ───────────────────────────

function TeamsPanel({ myName, onAsk }: { myName: string; onAsk: (a: AskSpec) => void }) {
  const qc = useQueryClient()
  const wss = useQuery({ queryKey: ['admin', 'workspaces'], queryFn: adminApi.workspaces })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin', 'workspaces'] }); qc.invalidateQueries({ queryKey: ['workspaces'] }) }

  const createWs = useMutation({
    mutationFn: (name: string) => workspacesApi.create(name),
    onSuccess: (ws) => { refresh(); toast(`팀 "${ws.name}" 생성됨`, 'ok') },
    onError: (e) => toast(errMsg(e) ?? '팀 생성에 실패했습니다.', 'error'),
  })

  const teams = (wss.data?.workspaces ?? []).filter((w) => w.kind === 'TEAM')
  const personals = (wss.data?.workspaces ?? []).filter((w) => w.kind === 'PERSONAL')
  const [showPersonal, setShowPersonal] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>
          🌐 공용 — 워크플로 {wss.data?.publicFlowCount ?? 0}개 · 모두(게스트 포함) 편집 가능(롤 없음)
        </span>
        <button style={{ ...primaryBtn, marginLeft: 'auto' }}
          onClick={() => onAsk({ title: '새 팀 워크스페이스', input: { label: '팀 이름', placeholder: '예: 결제팀' }, confirmLabel: '만들기', onConfirm: (name) => createWs.mutate(name) })}>
          + 새 팀
        </button>
      </div>

      {teams.map((w) => <TeamCard key={w.id} ws={w} myName={myName} onChanged={refresh} />)}
      {wss.data && teams.length === 0 && (
        <div style={{ ...card, padding: 24, textAlign: 'center', color: 'var(--fl-text-muted)', fontSize: 13 }}>
          아직 팀이 없습니다 — <b>+ 새 팀</b>으로 만들고 멤버에게 롤(OWNER/EDITOR/VIEWER)을 부여하세요.
        </div>
      )}

      {personals.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowPersonal((v) => !v)} style={{ background: 'transparent', border: 'none', color: 'var(--fl-text-muted)', fontSize: 12.5, cursor: 'pointer', padding: 0 }}>
            {showPersonal ? '▾' : '▸'} 개인 워크스페이스 {personals.length}개
          </button>
          {showPersonal && (
            <div style={{ ...card, marginTop: 8 }}>
              {personals.map((w) => <PersonalRow key={w.id} ws={w} onChanged={refresh} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TeamCard({ ws, myName, onChanged }: { ws: AdminWorkspaceView; myName: string; onChanged: () => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>('EDITOR')
  const [armDelete, setArmDelete] = useState(false)

  const put = useMutation({
    mutationFn: (v: { username: string; role: string }) => workspacesApi.putMember(ws.id, v.username, v.role),
    onSuccess: () => { onChanged(); setName('') },
    onError: (e) => toast(errMsg(e) ?? '멤버 저장에 실패했습니다.', 'error'),
  })
  const remove = useMutation({
    mutationFn: (username: string) => workspacesApi.removeMember(ws.id, username),
    onSuccess: onChanged,
    onError: (e) => toast(errMsg(e) ?? '내보내기에 실패했습니다.', 'error'),
  })
  const removeWs = useMutation({
    mutationFn: () => workspacesApi.remove(ws.id),
    onSuccess: () => { toast(`팀 "${ws.name}" 삭제 — 안의 워크플로/폴더는 공용으로 이동됨`, 'ok'); onChanged() },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
        <strong style={{ fontSize: 14.5 }}>👥 {ws.name}</strong>
        <span style={metaMono}>워크플로 {ws.flowCount}</span>
        <span style={metaMono}>멤버 {ws.members.length}</span>
        <div style={{ marginLeft: 'auto' }}>
          {armDelete ? (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>워크플로/폴더는 공용으로 이동됩니다 —</span>
              <button onClick={() => setArmDelete(false)} style={cancelMini}>취소</button>
              <button onClick={() => removeWs.mutate()} disabled={removeWs.isPending} style={{ ...miniDanger, background: 'var(--fl-fail)', color: '#fff' }}>정말 삭제</button>
            </span>
          ) : (
            <button onClick={() => setArmDelete(true)} style={miniDanger}>팀 삭제</button>
          )}
        </div>
      </div>
      <div style={{ padding: '10px 18px 14px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {ws.members.map((m) => (
              <tr key={m.username} style={{ borderBottom: '1px solid var(--fl-border)' }}>
                <td style={{ ...td, width: '34%' }}>
                  <span style={{ fontFamily: 'var(--fl-font-mono)' }}>{m.username}</span>
                  {m.username === myName && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fl-primary)' }}>(나)</span>}
                </td>
                <td style={td}>
                  <select value={m.role} onChange={(e) => put.mutate({ username: m.username, role: e.target.value })} style={selBox}>
                    {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
                  </select>
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => remove.mutate(m.username)} style={miniDanger}>내보내기</button>
                </td>
              </tr>
            ))}
            {ws.members.length === 0 && (
              <tr><td colSpan={3} style={{ ...td, color: 'var(--fl-text-muted)' }}>멤버가 없습니다(관리자는 항상 접근 가능).</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) put.mutate({ username: name.trim(), role }) }}
            placeholder="GitHub 사용자명" aria-label={`${ws.name} 에 추가할 사용자명`} style={{ ...inputBox, flex: 1 }} />
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="롤" style={selBox}>
            {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
          </select>
          <button onClick={() => name.trim() && put.mutate({ username: name.trim(), role })} disabled={!name.trim() || put.isPending} style={primaryBtn}>+ 멤버 추가</button>
        </div>
      </div>
    </div>
  )
}

function PersonalRow({ ws, onChanged }: { ws: AdminWorkspaceView; onChanged: () => void }) {
  const [arm, setArm] = useState(false)
  const removeWs = useMutation({
    mutationFn: () => workspacesApi.remove(ws.id),
    onSuccess: () => { toast(`"${ws.name}" 정리 — 워크플로는 공용으로 이동됨`, 'ok'); onChanged() },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: '1px solid var(--fl-border)', fontSize: 13 }}>
      <span>🔒 {ws.name}</span>
      <span style={metaMono}>워크플로 {ws.flowCount}</span>
      <span style={{ ...metaMono, marginLeft: 'auto' }}>{ws.ownerUsername}</span>
      {arm ? (
        <span style={{ display: 'inline-flex', gap: 5 }}>
          <button onClick={() => setArm(false)} style={cancelMini}>취소</button>
          <button onClick={() => removeWs.mutate()} style={{ ...miniDanger, background: 'var(--fl-fail)', color: '#fff' }}>정말 정리</button>
        </span>
      ) : (
        <button onClick={() => setArm(true)} title="탈퇴자 등 잔여 개인 공간 정리(워크플로는 공용으로)" style={miniDanger}>정리</button>
      )}
    </div>
  )
}

// ─────────────────────────── 스타일 ───────────────────────────

function roleColor(role: string): string {
  return role === 'OWNER' ? 'var(--fl-primary)' : role === 'VIEWER' ? 'var(--fl-waiting)' : 'var(--fl-ok)'
}

const tabBtn = (on: boolean): CSSProperties => ({
  padding: '7px 16px', border: '1px solid ' + (on ? 'var(--fl-primary)' : 'var(--fl-border)'), borderRadius: 'var(--fl-radius-sm)',
  background: on ? 'color-mix(in srgb, var(--fl-primary) 12%, transparent)' : 'transparent',
  color: on ? 'var(--fl-primary)' : 'var(--fl-text-muted)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
})
const card: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', background: 'var(--fl-surface)', overflow: 'hidden' }
const th: CSSProperties = { padding: '10px 12px', fontWeight: 600 }
const td: CSSProperties = { padding: '9px 12px' }
const hint: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', lineHeight: 1.7, margin: 0 }
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const searchBox: CSSProperties = { padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, minWidth: 180 }
const inputBox: CSSProperties = { padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-bg)', color: 'var(--fl-text)', fontSize: 13, minWidth: 170 }
const selBox: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const primaryBtn: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }
const miniDanger: CSSProperties = { padding: '5px 10px', border: '1px solid color-mix(in srgb, var(--fl-fail) 45%, transparent)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const cancelMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const teamChip: CSSProperties = { display: 'inline-flex', gap: 5, alignItems: 'center', padding: '3px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', fontSize: 11.5, background: 'var(--fl-surface-2)' }
