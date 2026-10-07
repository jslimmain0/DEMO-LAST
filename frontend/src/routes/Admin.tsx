import { PageHeader } from '../components/PageHeader'
import { AppIcon } from '../components/AppIcon'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { PluginScriptSummary } from '../api/types'
import { AppShellTier1 } from '../app/AppShell'
import { AskDialog } from '../components/AskDialog'
import { PluginDiffView } from '../components/PluginDiffView'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'
import { kindLabel } from '../lib/pluginTemplates'
import { catalogPage, matchesCatalog } from '../lib/catalog'
import { CatalogPagination } from '../components/CatalogPagination'
import './admin.css'
import { AdminUsers as UsersTab } from './AdminUsers'
import { AdminTeams as TeamsTab } from './AdminTeams'
import { ui } from '../design/ui'


/**
 * 관리 콘솔(/admin) — **관리자 전용** 회원·팀·권한 관리.
 * 사용자·팀은 테넌트 전체를 검색·페이지로 관리하고, 플러그인 요청은 선택한 공간 범위다.
 * 로그인 = 가입 신청(PENDING) → 여기서 승인/차단. 네비는 관리자에게만 노출, 백엔드 /admin/* 403 이중 방어.
 */
export function Admin() {
  const { adminApi, pluginsApi } = useApi()

  const scope = useWorkspace()
  const local = scope.current.origin === 'local'
  const qc = useQueryClient()
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000, refetchOnMount: 'always' })
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users, enabled: me.data?.admin === true && !local })
  const wss = useQuery({ queryKey: ['admin', 'workspaces'], queryFn: adminApi.workspaces, enabled: me.data?.admin === true && !local })
  const pendingPlugins = useQuery({ queryKey: ['plugins', 'scripts', 'PENDING'], queryFn: () => pluginsApi.list('PENDING'), enabled: me.data?.admin === true, refetchInterval: 30_000 })
  const [tab, setTab] = useState<'users' | 'teams' | 'plugins'>('users')
  const [changingUser, setChangingUser] = useState(false)

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['admin'] })
    void qc.invalidateQueries({ queryKey: ['workspaces'] })
    void pendingPlugins.refetch()
    scope.refresh()
  }
  const refreshing = users.isFetching || wss.isFetching || pendingPlugins.isFetching

  // 로딩 중엔 판정 보류 — 비관리자에게 콘솔을 한 번 그렸다가 차단 화면으로 바뀌는 깜빡임 방지
  if (me.isPending) {
    return (
      <AppShellTier1>
        <div style={{ maxWidth: 1080, margin: '0 auto', padding: '36px 40px' }}>
          <div style={{ height: 34, width: 240, borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface-2)', opacity: 0.6 }} />
          <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
            {[0, 1, 2, 3].map((i) => <div key={i} style={{ flex: 1, height: 86, borderRadius: 14, background: 'var(--fl-surface-2)', opacity: 0.4 }} />)}
          </div>
          <div style={{ marginTop: 18, height: 220, borderRadius: 14, background: 'var(--fl-surface-2)', opacity: 0.3 }} />
        </div>
      </AppShellTier1>
    )
  }
  if (me.isError) return <AppShellTier1><div className="fl-admin fl-page"><h1>관리 권한을 확인하지 못했습니다</h1><p>서버 연결과 로그인 상태를 확인하세요.</p><button style={ghostBtn} onClick={() => void me.refetch()}>다시 확인</button></div></AppShellTier1>
  if (!me.data?.admin) {
    return (
      <AppShellTier1>
        <div style={{ maxWidth: 700, margin: '80px auto', textAlign: 'center', padding: '0 20px' }}>
          <AppIcon name="shield" size={32} style={{ color: 'var(--fl-text-muted)' }} />
          <h2 style={{ fontFamily: 'var(--fl-font-head)', margin: '12px 0 8px' }}>관리자만 접근할 수 있습니다</h2>
          <p style={{ color: 'var(--fl-text-muted)', fontSize: 14, lineHeight: 1.7 }}>
            관리 콘솔은 전역 ADMIN 권한이 필요합니다.<br />
            운영자(전역 ADMIN)에게 권한을 요청하세요.
          </p>
        </div>
      </AppShellTier1>
    )
  }

  const allUsers = users.data ?? []
  const teams = (wss.data?.workspaces ?? []).filter((w) => w.kind === 'TEAM')
  const personals = (wss.data?.workspaces ?? []).filter((w) => w.kind === 'PERSONAL')

  if (local) return <AppShellTier1><div className="fl-admin" style={{ maxWidth: 900, margin: '0 auto', padding: 32 }}>
    <h1>개인 플러그인 관리</h1><p>PC의 플러그인 승인 요청입니다. 회원과 팀은 서버 공간에서 관리하세요.</p>
    <PluginRequests requests={pendingPlugins.data ?? []} loading={pendingPlugins.isPending} error={pendingPlugins.isError} onRetry={() => void pendingPlugins.refetch()} onDone={() => { void pendingPlugins.refetch(); void qc.invalidateQueries({ queryKey: ['plugins'] }) }} />
  </div></AppShellTier1>

  return (
    <AppShellTier1>
      <div className="fl-admin fl-page">
        <PageHeader title="서버 관리" description="동일 회사(테넌트)의 사용자와 팀을 관리합니다." actions={<button onClick={refreshAll} disabled={refreshing} aria-label="새로고침" style={ghostBtn}><AppIcon name="refresh" size={16} /> 새로고침</button>}>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 0, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-pill)', overflow: 'hidden' }}>
            <button disabled={changingUser} aria-pressed={tab === 'users'} onClick={() => setTab('users')} style={segTab(tab === 'users')}>
              사용자 <b style={segCount(tab === 'users')}>{allUsers.length}</b>
            </button>
            <button disabled={changingUser} aria-pressed={tab === 'teams'} onClick={() => setTab('teams')} style={segTab(tab === 'teams')}>
              팀 <b style={segCount(tab === 'teams')}>{teams.length}</b>
            </button>
            <button disabled={changingUser} aria-pressed={tab === 'plugins'} onClick={() => setTab('plugins')} style={segTab(tab === 'plugins')}>공간의 플러그인 요청 <b style={segCount(tab === 'plugins')}>{pendingPlugins.data?.length ?? 0}</b></button>
          </div>
        </PageHeader>

        {/* ── 본문 ── */}
        <div style={{ marginTop: 22 }}>
          {(users.isError || wss.isError) && (
            <div style={{ ...panel, padding: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20 }}>⚠</span>
              <span style={{ fontSize: 13 }}>데이터를 불러오지 못했습니다.</span>
              <button onClick={refreshAll} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {tab !== 'plugins' && (users.isError || wss.isError) ? <p className="fl-admin-note" role="alert">사용자와 팀 정보가 확인될 때까지 권한을 변경하지 않습니다.</p> : tab === 'users'
            ? <UsersTab myName={me.data.username} users={allUsers} loading={users.isPending} teams={teams} onRefresh={refreshAll} onBusyChange={setChangingUser} />
            : tab === 'plugins' ? <><p className="fl-admin-note">플러그인 요청 범위: <b>{scope.current.name}</b> · ID {scope.current.id.slice(0, 8)}. 다른 공간의 요청은 해당 공간을 선택해 확인하세요.</p><PluginRequests requests={pendingPlugins.data ?? []} loading={pendingPlugins.isPending} error={pendingPlugins.isError} onRetry={() => void pendingPlugins.refetch()} onDone={() => { void pendingPlugins.refetch(); void qc.invalidateQueries({ queryKey: ['plugins'] }); void qc.invalidateQueries({ queryKey: ['admin', 'me'] }) }} /></>
            : <TeamsTab users={allUsers} teams={teams} personals={personals}
                publicFlowCount={wss.data?.publicFlowCount ?? 0} publicMockCount={wss.data?.publicMockCount ?? 0}
                loading={wss.isPending} onRefresh={refreshAll} />}
        </div>
      </div>
      {/* 새로고침 스피너 키프레임 — 인라인 스타일로는 못 넣는 유일한 조각 */}
      <style>{'@keyframes fl-spin { to { transform: rotate(360deg) } }'}</style>
    </AppShellTier1>
  )
}

// ═══════════════════════════ 공용 조각 ═══════════════════════════


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

/**
 * 대상과 영향을 명시하는 플러그인 승인·반려 확인.
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
  const color = tone === 'danger' ? 'var(--fl-fail)' : 'var(--fl-ok)'
  return <><button onClick={() => setArmed(true)} disabled={pending} style={{ ...chipBtn, color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }}>{label}</button>{armed && <AskDialog spec={{ title: confirmLabel ?? '변경 확인', message: title, confirmLabel: confirmLabel ?? '확정', danger: tone === 'danger', onConfirm }} onClose={() => setArmed(false)} />}</>
}

function PluginRequests({ requests, loading, error, onRetry, onDone }: { requests: PluginScriptSummary[]; loading: boolean; error: boolean; onRetry: () => void; onDone: () => void }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const filtered = requests.filter(request => matchesCatalog(search, [request.name, request.pluginId, request.submittedBy, request.createdBy])).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }))
  const range = catalogPage(filtered.length, page, 10)
  if (error) return <p role="alert">승인 요청을 불러오지 못했습니다. <button style={ghostBtn} onClick={onRetry}>다시 불러오기</button></p>
  return <section aria-label="플러그인 승인 요청"><p className="fl-admin-note">코드와 제출 샘플을 확인한 뒤 승인하세요. 승인하면 이 공간의 사용처에 즉시 반영됩니다.</p><div className="fl-admin-toolbar"><input type="search" aria-label="플러그인 요청 검색" placeholder="플러그인 이름·ID·제출자 검색" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></div><CatalogPagination total={filtered.length} page={range.page} size={10} onPage={setPage} label="플러그인 요청" /><div style={panel}>{filtered.slice(range.start, range.end).map((request, index) => <PendingPluginRow key={request.id} p={request} first={index === 0} onDone={onDone} />)}</div>{!filtered.length && <p role="status" className="fl-admin-note">{loading ? '승인 요청을 불러오는 중입니다.' : requests.length ? '조건에 맞는 요청이 없습니다.' : '이 공간에 승인 대기 중인 플러그인이 없습니다.'}</p>}</section>
}

/** 승인 요청 한 건 — 펼치면 승인본 대비 diff + 제출 샘플. 승인/반려는 ConfirmChip. */
function PendingPluginRow({ p, first, onDone }: { p: PluginScriptSummary; first: boolean; onDone: () => void }) {
  const { pluginsApi } = useApi()

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const detail = useQuery({ queryKey: ['plugins', 'scripts', p.id], queryFn: () => pluginsApi.get(p.id), enabled: open })
  const sample = useMemo(() => { try { return detail.data?.sampleJson ? JSON.parse(detail.data.sampleJson) as { request?: unknown; result?: { outputs?: unknown; result?: unknown; logs?: string[] } } : null } catch { return null } }, [detail.data])
  const act = async (op: 'approve' | 'reject') => {
    setBusy(true)
    try { if (op === 'approve') await pluginsApi.approve(p.id); else await pluginsApi.reject(p.id, note); toast(op === 'approve' ? `${p.name} 승인됨 — 즉시 서빙` : `${p.name} 반려함`, 'ok'); onDone() }
    catch (e) { toast(apiErrorMessage(e), 'error') } finally { setBusy(false) }
  }
  return (
    <div style={{ borderTop: first ? 'none' : '1px solid var(--fl-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: '12px 18px' }}>
        <Avatar name={p.submittedBy ?? p.createdBy} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: 14 }}>{p.name} <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 400, fontSize: 12, color: 'var(--fl-text-muted)' }}>#{p.pluginId} · {kindLabel(p.kind)}</span></span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--fl-text-muted)', marginTop: 1 }}>
            {p.submittedBy} · 요청 {relTime(p.updatedAt)}{p.live ? ' · 승인본 교체' : ' · 신규'}{p.usages > 0 ? ` · ⚠ 사용처 ${p.usages}곳에 즉시 반영` : ''}
          </span>
        </span>
        <button onClick={() => setOpen((v) => !v)} style={chipBtn}>{open ? '접기' : '코드·샘플 보기'}</button>
        <Link to={`/plugins/${p.id}`} style={{ ...chipBtn, textDecoration: 'none', color: 'var(--fl-text)' }}>편집기에서 열기</Link>
        <ConfirmChip tone="ok" label="승인" confirmLabel="승인 확정" pending={busy || !detail.data || detail.isError || detail.isFetching} title={`${p.name}을 승인하면 이 공간의 사용처 ${p.usages}곳에 즉시 반영됩니다.`} onConfirm={() => void act('approve')} />
        <ConfirmChip label="반려" confirmLabel="반려 확정" pending={busy} title={`${p.name}의 승인 요청을 반려합니다.${note ? ` 사유: ${note}` : ' 반려 사유가 입력되지 않았습니다.'}`} onConfirm={() => void act('reject')} />
      </div>
      {open && (
        <div style={{ padding: '0 18px 14px', display: 'grid', gap: 10 }}>
          <input aria-label={`${p.name} 반려 사유`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="반려 사유(반려 시 제출자에게 보임)" style={{ padding: '6px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 13 }} />
          <div style={{ border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', maxHeight: 420, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {detail.isError ? <div role="alert" style={{ padding: 12 }}>코드를 불러오지 못했습니다. <button style={ghostBtn} onClick={() => void detail.refetch()}>다시 확인</button></div> : detail.data ? <PluginDiffView before={detail.data.liveSource ?? ''} after={detail.data.source} /> : <div style={{ padding: 12, fontSize: 13, color: 'var(--fl-text-muted)' }}>불러오는 중…</div>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>
            {sample ? <>제출자 샘플 — 입력 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{JSON.stringify(sample.request)}</code> → 결과 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{JSON.stringify(sample.result?.outputs ?? sample.result?.result ?? sample.result)}</code></> : '제출자가 돌린 샘플이 없습니다 — 편집기에서 열어 직접 실행해 보세요.'}
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════ 사용자 탭 ═══════════════════════════

// ═══════════════════════════ 팀 · 권한 탭 ═══════════════════════════

// ═══════════════════════════ 스타일 ═══════════════════════════


const panel: CSSProperties = { border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', background: 'var(--fl-surface)' }
const ghostBtn: CSSProperties = { ...ui.secondary }
const chipBtn: CSSProperties = { ...ui.mini }
const segTab = (on: boolean): CSSProperties => ({
  padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
  background: on ? 'var(--fl-action-primary-bg)' : 'transparent', color: on ? 'var(--fl-action-primary-ink)' : 'var(--fl-text-muted)',
  display: 'inline-flex', alignItems: 'center', gap: 7,
})
const segCount = (on: boolean): CSSProperties => ({
  minWidth: 19, height: 19, padding: '0 5px', borderRadius: 'var(--fl-radius)', display: 'inline-grid', placeItems: 'center',
  fontSize: 11, background: on ? 'rgba(255,255,255,.22)' : 'var(--fl-surface-2)', color: on ? '#fff' : 'var(--fl-text-muted)',
})
