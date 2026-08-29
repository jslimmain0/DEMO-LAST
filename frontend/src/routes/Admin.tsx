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
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000, refetchOnMount: 'always' })
  const [tab, setTab] = useState<'users' | 'teams'>('users')
  const [ask, setAsk] = useState<AskSpec | null>(null)

  // 로딩 중엔 판정 보류 — 비관리자에게 콘솔 UI 를 한 번 그렸다가 403 두 발 쏘고 차단 화면으로 바뀌던 깜빡임 방지
  if (me.isPending) {
    return (
      <AppShellTier1>
        <div style={{ maxWidth: 1020, margin: '0 auto', padding: '36px 40px' }}>
          <div style={{ height: 34, width: 220, borderRadius: 8, background: 'var(--fl-surface-2)', opacity: 0.6 }} />
          <div style={{ marginTop: 24, height: 180, borderRadius: 12, background: 'var(--fl-surface-2)', opacity: 0.4 }} />
        </div>
      </AppShellTier1>
    )
  }
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
  const [q, setQ] = useState('')
  const [armDel, setArmDel] = useState<string | null>(null)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'users'] })
    qc.invalidateQueries({ queryKey: ['admin', 'workspaces'] })
    qc.invalidateQueries({ queryKey: ['admin', 'me'] }) // 네비 신청 배지 갱신
  }

  const putUser = useMutation({
    mutationFn: (v: { username: string; body: { globalRole?: string; status?: string } }) => adminApi.putUser(v.username, v.body),
    onSuccess: (_d, v) => { refresh(); if (v.body.status === 'APPROVED') toast(v.username + ' 승인됨 — 개인 워크스페이스·팀 배정·AI 사용 가능', 'ok'); else if (v.body.status === 'BLOCKED') toast(v.username + ' 차단됨 — 로그인이 거부됩니다', 'ok') },
    onError: (e) => toast(errMsg(e) ?? '저장에 실패했습니다.', 'error'),
  })
  const pendingUser = putUser.isPending ? putUser.variables?.username : null
  const delUser = useMutation({
    mutationFn: (username: string) => adminApi.removeUser(username),
    onSuccess: () => { refresh(); setArmDel(null); toast('사용자를 삭제했습니다(팀 멤버십도 정리).', 'ok') },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })
  const approve = (username: string) => putUser.mutate({ username, body: { status: 'APPROVED' } })
  const block = (username: string) => putUser.mutate({ username, body: { status: 'BLOCKED' } })

  // 사용자별 소속 팀 — admin/workspaces 의 멤버 목록에서 역인덱스
  const teamsOf = (username: string): Array<{ name: string; role: string }> =>
    (wss.data?.workspaces ?? [])
      .filter((w) => w.kind === 'TEAM')
      .flatMap((w) => w.members.filter((m) => m.username === username).map((m) => ({ name: w.name, role: m.role })))

  const all = users.data ?? []
  const pending = all.filter((u) => u.status === 'PENDING')
  const query = q.trim().toLowerCase()
  const members = all.filter((u) => u.status !== 'PENDING' && (!query || u.username.toLowerCase().includes(query)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── 가입 신청 — GitHub 로그인하면 자동 접수, 관리자가 승인 ── */}
      {pending.length > 0 && (
        <div style={{ ...card, borderColor: 'color-mix(in srgb, var(--fl-waiting) 55%, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 18px', borderBottom: '1px solid var(--fl-border)' }}>
            <strong style={{ fontSize: 14 }}>🔔 가입 신청</strong>
            <span style={pendingBadge}>{pending.length}</span>
            <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>GitHub 로그인한 계정이 자동으로 접수됩니다 — 승인하면 개인 워크스페이스·팀 배정·AI 사용 가능</span>
          </div>
          {pending.map((u) => (
            <div key={u.username} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 18px', borderBottom: '1px solid var(--fl-border)' }}>
              <span aria-hidden style={avatarDot}>{u.username.slice(0, 1).toUpperCase()}</span>
              <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 700, fontSize: 13.5 }}>{u.username}</span>
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>
                신청 {u.createdAt ? relTime(u.createdAt) : '—'}{u.lastSeenAt ? ` · 최근 접속 ${relTime(u.lastSeenAt)}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button onClick={() => approve(u.username)} disabled={pendingUser === u.username} style={approveBtn}>{pendingUser === u.username ? '처리 중…' : '✓ 승인'}</button>
                <button onClick={() => block(u.username)} disabled={pendingUser === u.username} style={miniDanger}>차단</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── 멤버 목록 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>멤버</strong>
        <span style={{ fontSize: 12, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{members.length}명</span>
        {(all.length >= 6) && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="사용자 검색…"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} style={{ ...searchBox, marginLeft: 'auto' }} />
        )}
      </div>
      <div style={{ ...card, overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fl-text-muted)', fontSize: 11.5 }}>
              <th style={th}>사용자</th><th style={th}>상태</th><th style={th}>전역 롤</th><th style={th}>소속 팀</th><th style={th}>최근 접속</th><th style={{ ...th, width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {members.map((u: AdminUserView) => (
              <tr key={u.username} style={{ borderTop: '1px solid var(--fl-border)', opacity: u.status === 'BLOCKED' ? 0.6 : 1 }}>
                <td style={td}>
                  <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 600 }}>{u.username}</span>
                  {u.username === myName && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fl-primary)' }}>(나)</span>}
                </td>
                <td style={td}><StatusPill status={u.status} /></td>
                <td style={td}>
                  <select value={u.globalRole} disabled={u.username === myName}
                    title={u.username === myName ? '자기 자신의 전역 롤은 바꿀 수 없습니다' : undefined}
                    onChange={(e) => putUser.mutate({ username: u.username, body: { globalRole: e.target.value } })} style={selBox}>
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
                      <button onClick={() => delUser.mutate(u.username)} disabled={delUser.isPending} style={{ ...miniDanger, background: 'var(--fl-fail)', color: '#fff' }}>정말 삭제</button>
                    </span>
                  ) : (
                    <span style={{ display: 'inline-flex', gap: 5 }}>
                      {u.status === 'BLOCKED'
                        ? <button onClick={() => approve(u.username)} style={approveBtn}>차단 해제</button>
                        : <button onClick={() => block(u.username)} title="차단하면 로그인 자체가 거부됩니다" style={miniDanger}>차단</button>}
                      <button onClick={() => setArmDel(u.username)} title="레지스트리에서 삭제(팀 멤버십도 정리)" style={miniDanger}>삭제</button>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
            {users.data && members.length === 0 && (
              <tr><td colSpan={6} style={{ ...td, color: 'var(--fl-text-muted)' }}>{query ? '검색 결과가 없습니다.' : 'GitHub 로그인한 사용자가 여기에 나타납니다(로그인 = 가입 신청).'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p style={hint}>
        <b>로그인 = 가입 신청</b> — GitHub 로그인하면 자동으로 신청 목록에 올라오고, 승인해야 개인 워크스페이스·팀 배정·AI 를 씁니다.
        <b> 차단</b>은 로그인 자체를 거부. 전역 <b>ADMIN</b> 은 모든 워크스페이스의 OWNER 격 + 이 콘솔 접근
        (env <code>FLOWLINK_AUTH_ADMIN_LOGINS</code> 부트스트랩 관리자와 <code>FLOWLINK_AUTH_ALLOWED_LOGINS</code> 화이트리스트 계정은 자동 승인).
      </p>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const [bg, fg, label] =
    status === 'APPROVED' ? ['color-mix(in srgb, var(--fl-ok) 15%, transparent)', 'var(--fl-ok)', '✓ 승인']
    : status === 'BLOCKED' ? ['color-mix(in srgb, var(--fl-fail) 15%, transparent)', 'var(--fl-fail)', '차단됨']
    : ['color-mix(in srgb, var(--fl-waiting) 18%, transparent)', 'var(--fl-waiting)', '대기']
  return <span style={{ padding: '3px 10px', borderRadius: 'var(--fl-radius-pill)', fontSize: 11.5, fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>{label}</span>
}

// ─────────────────────────── 팀 · 권한 탭 ───────────────────────────

function TeamsPanel({ myName, onAsk }: { myName: string; onAsk: (a: AskSpec) => void }) {
  const qc = useQueryClient()
  const wss = useQuery({ queryKey: ['admin', 'workspaces'], queryFn: adminApi.workspaces })
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users })
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

      {teams.map((w) => <TeamCard key={w.id} ws={w} myName={myName} allUsers={users.data ?? []} onChanged={refresh} />)}
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

function TeamCard({ ws, myName, allUsers, onChanged }: { ws: AdminWorkspaceView; myName: string; allUsers: AdminUserView[]; onChanged: () => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<string>('EDITOR')
  const [armDelete, setArmDelete] = useState(false)
  // 추가 후보 = 등록된 사용자 중 아직 이 팀 멤버가 아닌 사람(차단 제외) — 계정을 타이핑하지 않는다
  const memberSet = new Set(ws.members.map((m) => m.username))
  const candidates = allUsers.filter((u) => !memberSet.has(u.username) && u.status !== 'BLOCKED')

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
    onSuccess: () => { toast(`팀 "${ws.name}" 삭제 — 안의 워크플로/폴더/Mock 은 내 개인 워크스페이스로 이동됨`, 'ok'); onChanged() },
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
              <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>워크플로/폴더/Mock 은 내 개인 워크스페이스로 이동됩니다(비공개 유지) —</span>
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
                  {(() => { const st = allUsers.find((u) => u.username === m.username)?.status; return st && st !== 'APPROVED' ? <span style={{ marginLeft: 8 }}><StatusPill status={st} /></span> : null })()}
                </td>
                <td style={td}>
                  <select value={m.role} onChange={(e) => put.mutate({ username: m.username, role: e.target.value })} style={selBox}>
                    {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
                  </select>
                </td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => remove.mutate(m.username)} disabled={remove.isPending} style={miniDanger}>내보내기</button>
                </td>
              </tr>
            ))}
            {ws.members.length === 0 && (
              <tr><td colSpan={3} style={{ ...td, color: 'var(--fl-text-muted)' }}>멤버가 없습니다(관리자는 항상 접근 가능).</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <select value={name} onChange={(e) => setName(e.target.value)} aria-label={`${ws.name} 에 추가할 사용자`} style={{ ...selBox, flex: 1, minWidth: 0 }}>
            <option value="">{candidates.length === 0 ? '추가할 사용자가 없습니다 — 로그인(가입 신청)한 사용자만 목록에 나옵니다' : '사용자 선택…'}</option>
            {candidates.map((u) => (
              <option key={u.username} value={u.username}>{u.username}{u.status === 'PENDING' ? ' (승인 대기)' : ''}</option>
            ))}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="롤" style={selBox}>
            {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
          </select>
          <button onClick={() => name && put.mutate({ username: name, role })} disabled={!name || put.isPending} style={primaryBtn}>+ 멤버 추가</button>
        </div>
      </div>
    </div>
  )
}

function PersonalRow({ ws, onChanged }: { ws: AdminWorkspaceView; onChanged: () => void }) {
  const [arm, setArm] = useState(false)
  const removeWs = useMutation({
    mutationFn: () => workspacesApi.remove(ws.id),
    onSuccess: () => { toast(`"${ws.name}" 정리 — 내용물은 내 개인 워크스페이스로 이동됨`, 'ok'); onChanged() },
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
          <button onClick={() => removeWs.mutate()} disabled={removeWs.isPending} style={{ ...miniDanger, background: 'var(--fl-fail)', color: '#fff' }}>정말 정리</button>
        </span>
      ) : (
        <button onClick={() => setArm(true)} title="탈퇴자 등 잔여 개인 공간 정리(내용물은 내 개인 워크스페이스로)" style={miniDanger}>정리</button>
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
const pendingBadge: CSSProperties = { minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, display: 'inline-grid', placeItems: 'center', background: 'var(--fl-waiting)', color: '#1a1d27', fontSize: 11.5, fontWeight: 800 }
const avatarDot: CSSProperties = { width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,var(--fl-primary),var(--fl-primary-2))', flexShrink: 0 }
const approveBtn: CSSProperties = { padding: '5px 12px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-ok)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }
const selBox: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const primaryBtn: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }
const miniDanger: CSSProperties = { padding: '5px 10px', border: '1px solid color-mix(in srgb, var(--fl-fail) 45%, transparent)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const cancelMini: CSSProperties = { padding: '5px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const teamChip: CSSProperties = { display: 'inline-flex', gap: 5, alignItems: 'center', padding: '3px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', fontSize: 11.5, background: 'var(--fl-surface-2)' }
