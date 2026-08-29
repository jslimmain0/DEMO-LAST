import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { adminApi, workspacesApi } from '../api/client'
import type { AdminUserView, AdminWorkspaceView } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import { toast } from '../components/toast'
import { relTime } from '../lib/format'

/**
 * 관리 콘솔(/admin) — **관리자 전용** 회원·팀·권한 관리.
 * 상단 현황 스트립(멤버/가입 신청/팀/워크플로) + [사용자] 신청 큐·멤버 목록 + [팀·권한] 팀 카드·개인 공간.
 * 로그인 = 가입 신청(PENDING) → 여기서 승인/차단. 네비는 관리자에게만 노출, 백엔드 /admin/* 403 이중 방어.
 */
export function Admin() {
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000, refetchOnMount: 'always' })
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users, enabled: me.data?.admin === true })
  const wss = useQuery({ queryKey: ['admin', 'workspaces'], queryFn: adminApi.workspaces, enabled: me.data?.admin === true })
  const [tab, setTab] = useState<'users' | 'teams'>('users')
  const [ask, setAsk] = useState<AskSpec | null>(null)

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['admin'] })
    void qc.invalidateQueries({ queryKey: ['workspaces'] })
  }
  const refreshing = users.isFetching || wss.isFetching

  // 로딩 중엔 판정 보류 — 비관리자에게 콘솔을 한 번 그렸다가 차단 화면으로 바뀌는 깜빡임 방지
  if (me.isPending) {
    return (
      <AppShellTier1>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '36px 40px' }}>
          <div style={{ height: 34, width: 240, borderRadius: 8, background: 'var(--fl-surface-2)', opacity: 0.6 }} />
          <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
            {[0, 1, 2, 3].map((i) => <div key={i} style={{ flex: 1, height: 86, borderRadius: 14, background: 'var(--fl-surface-2)', opacity: 0.4 }} />)}
          </div>
          <div style={{ marginTop: 18, height: 220, borderRadius: 14, background: 'var(--fl-surface-2)', opacity: 0.3 }} />
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

  const allUsers = users.data ?? []
  const pending = allUsers.filter((u) => u.status === 'PENDING')
  const teams = (wss.data?.workspaces ?? []).filter((w) => w.kind === 'TEAM')
  const personals = (wss.data?.workspaces ?? []).filter((w) => w.kind === 'PERSONAL')
  const totalFlows = (wss.data?.publicFlowCount ?? 0) + (wss.data?.workspaces ?? []).reduce((a, w) => a + w.flowCount, 0)

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 40px 80px' }}>
        {/* ── 헤더 ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>🛡 관리 콘솔</h1>
          <span style={{ fontSize: 12.5, color: 'var(--fl-text-muted)' }}>회원 · 팀 · 권한</span>
          <button onClick={refreshAll} disabled={refreshing} title="새로고침" aria-label="새로고침"
            style={{ ...iconBtn, marginLeft: 4, opacity: refreshing ? 0.5 : 1 }}>
            <span style={{ display: 'inline-block', animation: refreshing ? 'fl-spin 1s linear infinite' : undefined }}>↻</span>
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', overflow: 'hidden' }}>
            <button onClick={() => setTab('users')} style={segTab(tab === 'users')}>
              사용자 <b style={segCount(tab === 'users')}>{allUsers.length}</b>
            </button>
            <button onClick={() => setTab('teams')} style={segTab(tab === 'teams')}>
              팀 <b style={segCount(tab === 'teams')}>{teams.length}</b>
            </button>
          </div>
        </div>

        {/* ── 현황 스트립 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 20 }}>
          <StatCard icon="👤" label="멤버" value={allUsers.filter((u) => u.status !== 'PENDING').length} sub="승인·차단 포함" onClick={() => setTab('users')} />
          <StatCard icon="🔔" label="가입 신청" value={pending.length} accent={pending.length > 0 ? 'var(--fl-waiting)' : undefined}
            sub={pending.length > 0 ? '승인 대기 중 — 확인 필요' : '대기 없음'} onClick={() => setTab('users')} />
          <StatCard icon="👥" label="팀 워크스페이스" value={teams.length} sub={`개인 ${personals.length}개`} onClick={() => setTab('teams')} />
          <StatCard icon="▤" label="워크플로" value={totalFlows} sub={`공용 ${wss.data?.publicFlowCount ?? 0} · Mock ${wss.data?.publicMockCount ?? 0}`} onClick={() => setTab('teams')} />
        </div>

        {/* ── 본문 ── */}
        <div style={{ marginTop: 22 }}>
          {(users.isError || wss.isError) && (
            <div style={{ ...panel, padding: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20 }}>⚠</span>
              <span style={{ fontSize: 13 }}>데이터를 불러오지 못했습니다.</span>
              <button onClick={refreshAll} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {tab === 'users'
            ? <UsersTab myName={me.data?.username ?? ''} users={allUsers} loading={users.isPending} teams={teams} onRefresh={refreshAll} />
            : <TeamsTab myName={me.data?.username ?? ''} users={allUsers} teams={teams} personals={personals}
                publicFlowCount={wss.data?.publicFlowCount ?? 0} publicMockCount={wss.data?.publicMockCount ?? 0}
                loading={wss.isPending} onAsk={setAsk} onRefresh={refreshAll} />}
        </div>
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
      {/* 새로고침 스피너 키프레임 — 인라인 스타일로는 못 넣는 유일한 조각 */}
      <style>{'@keyframes fl-spin { to { transform: rotate(360deg) } }'}</style>
    </AppShellTier1>
  )
}

// ═══════════════════════════ 공용 조각 ═══════════════════════════

const ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const
const roleDesc: Record<string, string> = { OWNER: '관리+편집', EDITOR: '편집', VIEWER: '조회만' }
const errMsg = (e: unknown) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message

/** 사용자 아바타 — username 해시 기반 색(팀/사용자 어디서나 같은 색). */
function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const hue = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      display: 'inline-grid', placeItems: 'center', fontSize: size * 0.42, fontWeight: 800, color: '#fff',
      background: `linear-gradient(135deg, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 60% 42%))`,
    }}>{name.slice(0, 1).toUpperCase()}</span>
  )
}

/** 아바타 스택 — 팀 카드 헤더의 멤버 미리보기(겹침, 최대 5 + N). */
function AvatarStack({ names }: { names: string[] }) {
  const shown = names.slice(0, 5)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {shown.map((n, i) => (
        <span key={n} style={{ marginLeft: i === 0 ? 0 : -8, border: '2px solid var(--fl-surface)', borderRadius: '50%', display: 'inline-flex' }}>
          <Avatar name={n} size={24} />
        </span>
      ))}
      {names.length > shown.length && (
        <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>+{names.length - shown.length}</span>
      )}
    </span>
  )
}

function StatusPill({ status }: { status: string }) {
  const [bg, fg, label] =
    status === 'APPROVED' ? ['color-mix(in srgb, var(--fl-ok) 15%, transparent)', 'var(--fl-ok)', '✓ 승인']
    : status === 'BLOCKED' ? ['color-mix(in srgb, var(--fl-fail) 15%, transparent)', 'var(--fl-fail)', '차단됨']
    : ['color-mix(in srgb, var(--fl-waiting) 18%, transparent)', 'var(--fl-waiting)', '대기']
  return <span style={{ padding: '3px 10px', borderRadius: 'var(--fl-radius-pill)', fontSize: 11.5, fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>{label}</span>
}

/**
 * 파괴적 동작 공용 확인 칩 — 클릭하면 [취소 | 라벨] 로 펼쳐지고 4초 뒤 자동 해제.
 * (콘솔 전역에서 삭제/차단/정리의 확인 UX 를 한 가지 패턴으로 통일)
 */
function ConfirmChip({ label, confirmLabel, onConfirm, pending, title, tone = 'danger' }: {
  label: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  pending?: boolean
  title?: string
  tone?: 'danger' | 'ok'
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const arm = () => {
    setArmed(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setArmed(false), 4000)
  }
  const color = tone === 'danger' ? 'var(--fl-fail)' : 'var(--fl-ok)'
  if (!armed) {
    return <button onClick={arm} disabled={pending} title={title} style={{ ...chipBtn, color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>{label}</button>
  }
  return (
    <span style={{ display: 'inline-flex', gap: 5 }}>
      <button onClick={() => setArmed(false)} style={{ ...chipBtn, color: 'var(--fl-text-muted)' }}>취소</button>
      <button onClick={() => { setArmed(false); onConfirm() }} disabled={pending}
        style={{ ...chipBtn, background: color, borderColor: color, color: '#fff', fontWeight: 700 }}>
        {confirmLabel ?? '확정'}
      </button>
    </span>
  )
}

function StatCard({ icon, label, value, sub, accent, onClick }: {
  icon: string; label: string; value: number; sub?: string; accent?: string; onClick?: () => void
}) {
  return (
    <button onClick={onClick} style={{
      ...panel, textAlign: 'left', padding: '14px 16px', cursor: onClick ? 'pointer' : 'default',
      display: 'flex', gap: 12, alignItems: 'center', fontFamily: 'inherit',
      borderColor: accent ? `color-mix(in srgb, ${accent} 55%, transparent)` : 'var(--fl-border)',
      background: accent ? `color-mix(in srgb, ${accent} 7%, var(--fl-surface))` : 'var(--fl-surface)',
    }}>
      <span aria-hidden style={{ fontSize: 20, width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--fl-surface-2)', flexShrink: 0 }}>{icon}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 22, fontWeight: 800, fontFamily: 'var(--fl-font-head)', lineHeight: 1.1, color: accent ?? 'var(--fl-text)' }}>{value}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}{sub ? ` · ${sub}` : ''}</span>
      </span>
    </button>
  )
}

// ═══════════════════════════ 사용자 탭 ═══════════════════════════

function UsersTab({ myName, users, teams, loading, onRefresh }: {
  myName: string
  users: AdminUserView[]
  teams: AdminWorkspaceView[]
  loading: boolean
  onRefresh: () => void
}) {
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'APPROVED' | 'BLOCKED'>('all')
  const [sort, setSort] = useState<'recent' | 'name'>('recent')
  // 방금 승인된 행 하이라이트 — 정렬된 표 어딘가로 흡수되는 행을 몇 초간 눈으로 좇을 수 있게
  const [justChanged, setJustChanged] = useState<string | null>(null)

  const putUser = useMutation({
    mutationFn: (v: { username: string; body: { globalRole?: string; status?: string } }) => adminApi.putUser(v.username, v.body),
    onSuccess: (_d, v) => {
      onRefresh()
      if (v.body.status === 'APPROVED') { toast(`${v.username} 승인됨 — 개인 워크스페이스·팀 배정·AI 사용 가능`, 'ok'); setJustChanged(v.username); setTimeout(() => setJustChanged(null), 4000) }
      else if (v.body.status === 'BLOCKED') toast(`${v.username} 차단됨 — 로그인이 거부됩니다`, 'ok')
    },
    onError: (e) => toast(errMsg(e) ?? '저장에 실패했습니다.', 'error'),
  })
  const busyUser = putUser.isPending ? putUser.variables?.username : null
  const delUser = useMutation({
    mutationFn: (username: string) => adminApi.removeUser(username),
    onSuccess: (_d, username) => { onRefresh(); toast(`${username} 삭제됨 — 팀 멤버십 정리, 개인 공간은 내 개인 워크스페이스로 흡수`, 'ok') },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })
  const approve = (u: string) => putUser.mutate({ username: u, body: { status: 'APPROVED' } })
  const block = (u: string) => putUser.mutate({ username: u, body: { status: 'BLOCKED' } })
  const approveAll = async (names: string[]) => {
    for (const n of names) {
      try { await adminApi.putUser(n, { status: 'APPROVED' }) } catch { toast(`${n} 승인 실패`, 'error') }
    }
    onRefresh()
    toast(`${names.length}명 일괄 승인됨`, 'ok')
  }

  const teamsOf = (username: string): Array<{ name: string; role: string }> =>
    teams.flatMap((w) => w.members.filter((m) => m.username === username).map((m) => ({ name: w.name, role: m.role })))

  const pending = users.filter((u) => u.status === 'PENDING')
  const query = q.trim().toLowerCase()
  const members = users
    .filter((u) => u.status !== 'PENDING')
    .filter((u) => statusFilter === 'all' || u.status === statusFilter)
    .filter((u) => !query || u.username.toLowerCase().includes(query))
    .sort((a, b) => sort === 'name'
      ? a.username.localeCompare(b.username)
      : (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── 가입 신청 큐 ── */}
      {pending.length > 0 && (
        <div style={{ ...panel, borderColor: 'color-mix(in srgb, var(--fl-waiting) 55%, transparent)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', background: 'color-mix(in srgb, var(--fl-waiting) 8%, transparent)', borderBottom: '1px solid var(--fl-border)', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>🔔 가입 신청</strong>
            <span style={countBadge}>{pending.length}</span>
            <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>GitHub 로그인하면 자동 접수 — 승인해야 개인 워크스페이스·팀 배정·AI 가 열립니다</span>
            {pending.length >= 2 && (
              <span style={{ marginLeft: 'auto' }}>
                <ConfirmChip tone="ok" label={`✓ 모두 승인 (${pending.length})`} confirmLabel="전원 승인"
                  onConfirm={() => void approveAll(pending.map((p) => p.username))} />
              </span>
            )}
          </div>
          {pending.map((u, i) => (
            <div key={u.username} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px', borderTop: i > 0 ? '1px solid var(--fl-border)' : 'none' }}>
              <Avatar name={u.username} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontFamily: 'var(--fl-font-mono)', fontWeight: 700, fontSize: 13.5 }}>{u.username}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 1 }}>
                  신청 {u.createdAt ? relTime(u.createdAt) : '—'}{u.lastSeenAt ? ` · 최근 접속 ${relTime(u.lastSeenAt)}` : ''}
                </span>
              </span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <button onClick={() => approve(u.username)} disabled={busyUser === u.username} style={approveBtn}>
                  {busyUser === u.username ? '처리 중…' : '✓ 승인'}
                </button>
                <ConfirmChip label="차단" confirmLabel="차단 확정" pending={busyUser === u.username}
                  title="차단하면 로그인 자체가 거부됩니다" onConfirm={() => block(u.username)} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── 멤버 목록 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13.5 }}>멤버</strong>
        <span style={{ fontSize: 12, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{members.length}</span>
        <div style={{ display: 'inline-flex', gap: 3, marginLeft: 6 }}>
          {([['all', '전체'], ['APPROVED', '✓ 승인'], ['BLOCKED', '차단됨']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setStatusFilter(k)} style={filterChip(statusFilter === k)}>{lbl}</button>
          ))}
        </div>
        <div style={{ display: 'inline-flex', gap: 3, marginLeft: 2 }}>
          {([['recent', '최근 접속순'], ['name', '이름순']] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setSort(k)} style={filterChip(sort === k)}>{lbl}</button>
          ))}
        </div>
        {users.length >= 6 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="사용자 검색…"
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} style={{ ...searchBox, marginLeft: 'auto' }} />
        )}
      </div>

      <div style={{ ...panel, overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fl-text-muted)', fontSize: 11.5 }}>
              <th style={th}>사용자</th><th style={th}>상태</th><th style={th}>전역 롤</th><th style={th}>소속 팀</th><th style={th}>최근 접속</th><th style={{ ...th, width: 170 }} />
            </tr>
          </thead>
          <tbody>
            {members.map((u) => (
              <tr key={u.username} style={{
                borderTop: '1px solid var(--fl-border)',
                opacity: u.status === 'BLOCKED' ? 0.55 : 1,
                background: justChanged === u.username ? 'color-mix(in srgb, var(--fl-ok) 9%, transparent)' : undefined,
                transition: 'background .6s',
              }}>
                <td style={td}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
                    <Avatar name={u.username} size={26} />
                    <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 600 }}>{u.username}</span>
                    {u.username === myName && <span style={meTag}>나</span>}
                  </span>
                </td>
                <td style={td}><StatusPill status={u.status} /></td>
                <td style={td}>
                  {/* 전역 롤 세그먼트 — 자기 자신은 잠금(스스로 강등해 콘솔 접근을 잃는 사고 방지) */}
                  <span style={{ display: 'inline-flex', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', overflow: 'hidden' }}>
                    {(['ADMIN', 'MEMBER'] as const).map((r) => (
                      <button key={r} disabled={u.username === myName || busyUser === u.username}
                        title={u.username === myName ? '자기 자신의 전역 롤은 바꿀 수 없습니다' : r === 'ADMIN' ? '모든 워크스페이스 OWNER 격 + 관리 콘솔' : '일반 멤버'}
                        onClick={() => u.globalRole !== r && putUser.mutate({ username: u.username, body: { globalRole: r } })}
                        style={roleSeg(u.globalRole === r, u.username === myName)}>
                        {r === 'ADMIN' ? '🛡 ADMIN' : 'MEMBER'}
                      </button>
                    ))}
                  </span>
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
                  {u.username !== myName && (
                    <span style={{ display: 'inline-flex', gap: 5 }}>
                      {u.status === 'BLOCKED'
                        ? <button onClick={() => approve(u.username)} disabled={busyUser === u.username} style={approveBtn}>차단 해제</button>
                        : <ConfirmChip label="차단" confirmLabel="차단 확정" pending={busyUser === u.username}
                            title="차단하면 로그인 자체가 거부됩니다" onConfirm={() => block(u.username)} />}
                      <ConfirmChip label="삭제" confirmLabel="정말 삭제" pending={delUser.isPending}
                        title="레지스트리에서 삭제 — 팀 멤버십 정리, 개인 공간은 내 개인 워크스페이스로 흡수"
                        onConfirm={() => delUser.mutate(u.username)} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && members.length === 0 && (
              <tr><td colSpan={6} style={{ ...td, padding: 28, textAlign: 'center', color: 'var(--fl-text-muted)' }}>
                {query || statusFilter !== 'all' ? '조건에 맞는 멤버가 없습니다.' : 'GitHub 로그인한 사용자가 여기에 나타납니다 — 로그인 = 가입 신청.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p style={hint}>
        <b>로그인 = 가입 신청</b> — 승인해야 개인 워크스페이스·팀 배정·AI 가 열리고, <b>차단</b>은 로그인 자체를 거부합니다.
        전역 <b>ADMIN</b> 은 모든 워크스페이스의 OWNER 격 + 이 콘솔 접근
        (env <code>FLOWLINK_AUTH_ADMIN_LOGINS</code> 부트스트랩 관리자와 <code>FLOWLINK_AUTH_ALLOWED_LOGINS</code> 화이트리스트는 자동 승인).
      </p>
    </div>
  )
}

// ═══════════════════════════ 팀 · 권한 탭 ═══════════════════════════

function TeamsTab({ myName, users, teams, personals, publicFlowCount, publicMockCount, loading, onAsk, onRefresh }: {
  myName: string
  users: AdminUserView[]
  teams: AdminWorkspaceView[]
  personals: AdminWorkspaceView[]
  publicFlowCount: number
  publicMockCount: number
  loading: boolean
  onAsk: (a: AskSpec) => void
  onRefresh: () => void
}) {
  const createWs = useMutation({
    mutationFn: (name: string) => workspacesApi.create(name),
    onSuccess: (ws) => { onRefresh(); toast(`팀 "${ws.name}" 생성됨 — 멤버를 추가하고 롤을 부여하세요`, 'ok') },
    onError: (e) => toast(errMsg(e) ?? '팀 생성에 실패했습니다.', 'error'),
  })
  const [showPersonal, setShowPersonal] = useState(false)
  const userByName = new Map(users.map((u) => [u.username, u]))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 공용 요약 + 새 팀 */}
      <div style={{ ...panel, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ fontSize: 18 }}>🌐</span>
        <span style={{ minWidth: 0 }}>
          <b style={{ fontSize: 13.5 }}>공용 워크스페이스</b>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 1 }}>
            워크플로 {publicFlowCount} · Mock {publicMockCount} — 모두(게스트 포함) 편집 가능, 롤 없음
          </span>
        </span>
        <button style={{ ...primaryBtn, marginLeft: 'auto' }}
          onClick={() => onAsk({ title: '새 팀 워크스페이스', input: { label: '팀 이름', placeholder: '예: 결제팀' }, confirmLabel: '만들기', onConfirm: (name) => createWs.mutate(name) })}>
          + 새 팀
        </button>
      </div>

      {teams.map((w) => (
        <TeamCard key={w.id} ws={w} myName={myName} allUsers={users} userByName={userByName} onChanged={onRefresh} />
      ))}
      {!loading && teams.length === 0 && (
        <div style={{ ...panel, padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 26 }}>👥</div>
          <b style={{ display: 'block', marginTop: 8, fontSize: 14.5 }}>아직 팀이 없습니다</b>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--fl-text-muted)', lineHeight: 1.7 }}>
            <b>+ 새 팀</b>으로 만들고 멤버에게 롤을 부여하세요 — OWNER(관리+편집) · EDITOR(편집) · VIEWER(조회만).<br />
            팀에 넣은 워크플로·Mock 은 멤버만 볼 수 있습니다.
          </p>
        </div>
      )}

      {/* 개인 워크스페이스 */}
      {personals.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button onClick={() => setShowPersonal((v) => !v)}
            style={{ background: 'transparent', border: 'none', color: 'var(--fl-text-muted)', fontSize: 12.5, cursor: 'pointer', padding: '4px 2px', fontWeight: 600 }}>
            {showPersonal ? '▾' : '▸'} 개인 워크스페이스 {personals.length}개
          </button>
          {showPersonal && (
            <div style={{ ...panel, marginTop: 8, overflow: 'hidden' }}>
              {personals.map((w, i) => {
                const owner = w.ownerUsername ? userByName.get(w.ownerUsername) : undefined
                return (
                  <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: i > 0 ? '1px solid var(--fl-border)' : 'none', fontSize: 13 }}>
                    {w.ownerUsername && <Avatar name={w.ownerUsername} size={24} />}
                    <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 600 }}>{w.ownerUsername ?? w.name}</span>
                    {owner && owner.status !== 'APPROVED' && <StatusPill status={owner.status} />}
                    <span style={metaMono}>워크플로 {w.flowCount} · Mock {w.mockCount}</span>
                    <span style={{ ...metaMono, marginLeft: 'auto' }}>{owner?.lastSeenAt ? `접속 ${relTime(owner.lastSeenAt)}` : ''}</span>
                    <PersonalCleanup ws={w} onChanged={onRefresh} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PersonalCleanup({ ws, onChanged }: { ws: AdminWorkspaceView; onChanged: () => void }) {
  const removeWs = useMutation({
    mutationFn: () => workspacesApi.remove(ws.id),
    onSuccess: () => { toast(`"${ws.name}" 정리됨 — 내용물은 내 개인 워크스페이스로 이동`, 'ok'); onChanged() },
    onError: (e) => toast(errMsg(e) ?? '정리에 실패했습니다.', 'error'),
  })
  return (
    <ConfirmChip label="정리" confirmLabel="정말 정리" pending={removeWs.isPending}
      title="탈퇴자 등 잔여 개인 공간 정리 — 내용물은 내 개인 워크스페이스로 이동" onConfirm={() => removeWs.mutate()} />
  )
}

function TeamCard({ ws, myName, allUsers, userByName, onChanged }: {
  ws: AdminWorkspaceView
  myName: string
  allUsers: AdminUserView[]
  userByName: Map<string, AdminUserView>
  onChanged: () => void
}) {
  const [pick, setPick] = useState('')
  const [role, setRole] = useState<string>('EDITOR')

  const put = useMutation({
    mutationFn: (v: { username: string; role: string }) => workspacesApi.putMember(ws.id, v.username, v.role),
    onSuccess: (_d, v) => { onChanged(); setPick(''); toast(`${v.username} → ${ws.name} (${v.role})`, 'ok') },
    onError: (e) => toast(errMsg(e) ?? '멤버 저장에 실패했습니다.', 'error'),
  })
  const remove = useMutation({
    mutationFn: (username: string) => workspacesApi.removeMember(ws.id, username),
    onSuccess: onChanged,
    onError: (e) => toast(errMsg(e) ?? '내보내기에 실패했습니다.', 'error'),
  })
  const removeWs = useMutation({
    mutationFn: () => workspacesApi.remove(ws.id),
    onSuccess: () => { toast(`팀 "${ws.name}" 삭제됨 — 내용물은 내 개인 워크스페이스로 이동`, 'ok'); onChanged() },
    onError: (e) => toast(errMsg(e) ?? '삭제에 실패했습니다.', 'error'),
  })

  const memberSet = new Set(ws.members.map((m) => m.username))
  const candidates = allUsers.filter((u) => !memberSet.has(u.username) && u.status !== 'BLOCKED')

  return (
    <div style={{ ...panel, overflow: 'hidden' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)', flexWrap: 'wrap' }}>
        <span aria-hidden style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', fontSize: 16, background: 'color-mix(in srgb, var(--fl-primary) 14%, transparent)', flexShrink: 0 }}>👥</span>
        <span style={{ minWidth: 0 }}>
          <b style={{ fontSize: 14.5 }}>{ws.name}</b>
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 1 }}>
            워크플로 {ws.flowCount} · Mock {ws.mockCount} · 멤버 {ws.members.length}{ws.createdAt ? ` · 생성 ${relTime(ws.createdAt)}` : ''}
          </span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <AvatarStack names={ws.members.map((m) => m.username)} />
          <ConfirmChip label="팀 삭제" confirmLabel="정말 삭제" pending={removeWs.isPending}
            title="워크플로·Mock 은 내 개인 워크스페이스로 이동됩니다(유실 없음)" onConfirm={() => removeWs.mutate()} />
        </span>
      </div>

      {/* 멤버 */}
      <div style={{ padding: '6px 18px 14px' }}>
        {ws.members.map((m) => {
          const u = userByName.get(m.username)
          return (
            <div key={m.username} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--fl-border)' }}>
              <Avatar name={m.username} size={26} />
              <span style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.username}</span>
              {m.username === myName && <span style={meTag}>나</span>}
              {u && u.status !== 'APPROVED' && <StatusPill status={u.status} />}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                <select value={m.role} onChange={(e) => put.mutate({ username: m.username, role: e.target.value })} style={selBox} aria-label={`${m.username} 롤`}>
                  {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
                </select>
                <ConfirmChip label="내보내기" confirmLabel="내보내기 확정" pending={remove.isPending}
                  onConfirm={() => remove.mutate(m.username)} />
              </span>
            </div>
          )
        })}
        {ws.members.length === 0 && (
          <p style={{ ...hint, padding: '10px 0' }}>멤버가 없습니다 — 관리자는 항상 접근할 수 있습니다.</p>
        )}

        {/* 멤버 추가 — 등록된 사용자에서 선택(타이핑 없음) */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`${ws.name} 에 추가할 사용자`} style={{ ...selBox, flex: 1, minWidth: 0 }}>
            <option value="">{candidates.length === 0 ? '추가할 사용자가 없습니다 — 로그인(가입 신청)한 사용자만 목록에 나옵니다' : '사용자 선택…'}</option>
            {candidates.map((u) => (
              <option key={u.username} value={u.username}>{u.username}{u.status === 'PENDING' ? ' (승인 대기)' : ''}</option>
            ))}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="롤" style={selBox}>
            {ROLES.map((r) => <option key={r} value={r}>{r} — {roleDesc[r]}</option>)}
          </select>
          <button onClick={() => pick && put.mutate({ username: pick, role })} disabled={!pick || put.isPending} style={primaryBtn}>+ 멤버 추가</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════ 스타일 ═══════════════════════════

function roleColor(role: string): string {
  return role === 'OWNER' ? 'var(--fl-primary)' : role === 'VIEWER' ? 'var(--fl-waiting)' : 'var(--fl-ok)'
}

const panel: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', background: 'var(--fl-surface)' }
const th: CSSProperties = { padding: '10px 12px', fontWeight: 600 }
const td: CSSProperties = { padding: '10px 12px', verticalAlign: 'middle' }
const hint: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', lineHeight: 1.7, margin: 0 }
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const searchBox: CSSProperties = { padding: '7px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13, minWidth: 180 }
const selBox: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer' }
const primaryBtn: CSSProperties = { padding: '8px 15px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }
const ghostBtn: CSSProperties = { padding: '7px 13px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const iconBtn: CSSProperties = { width: 30, height: 30, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }
const chipBtn: CSSProperties = { padding: '5px 11px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', background: 'transparent', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const approveBtn: CSSProperties = { padding: '6px 13px', border: 'none', borderRadius: 'var(--fl-radius-pill)', background: 'var(--fl-ok)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }
const countBadge: CSSProperties = { minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10, display: 'inline-grid', placeItems: 'center', background: 'var(--fl-waiting)', color: '#1a1d27', fontSize: 11.5, fontWeight: 800 }
const meTag: CSSProperties = { padding: '1px 7px', borderRadius: 'var(--fl-radius-pill)', fontSize: 10.5, fontWeight: 800, background: 'color-mix(in srgb, var(--fl-primary) 15%, transparent)', color: 'var(--fl-primary)' }
const teamChip: CSSProperties = { display: 'inline-flex', gap: 5, alignItems: 'center', padding: '3px 9px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', fontSize: 11.5, background: 'var(--fl-surface-2)' }
const segTab = (on: boolean): CSSProperties => ({
  padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
  background: on ? 'var(--fl-primary)' : 'transparent', color: on ? '#fff' : 'var(--fl-text-muted)',
  display: 'inline-flex', alignItems: 'center', gap: 7,
})
const segCount = (on: boolean): CSSProperties => ({
  minWidth: 19, height: 19, padding: '0 5px', borderRadius: 10, display: 'inline-grid', placeItems: 'center',
  fontSize: 11, background: on ? 'rgba(255,255,255,.22)' : 'var(--fl-surface-2)', color: on ? '#fff' : 'var(--fl-text-muted)',
})
const filterChip = (on: boolean): CSSProperties => ({
  padding: '4px 11px', fontSize: 11.5, fontWeight: on ? 700 : 500, border: '1px solid ' + (on ? 'var(--fl-primary)' : 'var(--fl-border)'),
  borderRadius: 'var(--fl-radius-pill)', cursor: 'pointer',
  background: on ? 'color-mix(in srgb, var(--fl-primary) 12%, transparent)' : 'transparent',
  color: on ? 'var(--fl-primary)' : 'var(--fl-text-muted)',
})
const roleSeg = (on: boolean, locked: boolean): CSSProperties => ({
  padding: '4px 10px', border: 'none', fontSize: 11, fontWeight: on ? 800 : 500, fontFamily: 'inherit',
  cursor: locked ? 'not-allowed' : 'pointer',
  background: on ? 'color-mix(in srgb, var(--fl-primary) 16%, transparent)' : 'transparent',
  color: on ? 'var(--fl-primary)' : 'var(--fl-text-muted)',
  opacity: locked && !on ? 0.45 : 1,
})
