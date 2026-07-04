import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import type { ExecutionStatus, ExecutionSummary } from '../api/types'
import { runsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { StatusBadge } from '../components/StatusBadge'
import { duration, relTime } from '../lib/format'

const STATUS_COLOR: Record<string, string> = {
  SUCCEEDED: 'var(--fl-ok)', FAILED: 'var(--fl-fail)', RUNNING: 'var(--fl-running)',
  WAITING: 'var(--fl-waiting)', PENDING: 'var(--fl-pending)', CANCELLED: 'var(--fl-pending)',
}
const TRIGGER_LABEL: Record<string, string> = { MANUAL: '수동', SCHEDULE: '예약', WEBHOOK: '웹훅', EVENT: '이벤트' }

function statusColor(s: ExecutionStatus): string {
  return STATUS_COLOR[s] ?? 'var(--fl-text-muted)'
}
function elapsed(e: ExecutionSummary): string | null {
  if (!e.startedAt || !e.finishedAt) return null
  const ms = new Date(e.finishedAt).getTime() - new Date(e.startedAt).getTime()
  return ms >= 0 ? duration(ms) : null
}

export function Executions() {
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['executions', 'recent'], queryFn: () => runsApi.recent(50) })
  const rows = data ?? []
  const okCount = rows.filter((e) => e.status === 'SUCCEEDED').length
  const failCount = rows.filter((e) => e.status === 'FAILED').length

  return (
    <AppShellTier1>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '36px 40px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', letterSpacing: '-.02em', margin: 0 }}>실행 이력</h1>
          {rows.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 4 }}>
              <span style={metaMono}>{rows.length}건</span>
              {okCount > 0 && <span style={{ ...metaMono, color: 'var(--fl-ok)' }}>✓ {okCount}</span>}
              {failCount > 0 && <span style={{ ...metaMono, color: 'var(--fl-fail)' }}>✕ {failCount}</span>}
            </div>
          )}
        </div>

        <div style={{ marginTop: 24 }}>
          {isLoading && <div style={{ display: 'grid', gap: 10 }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ ...rowCard, borderLeft: '3px solid var(--fl-border)', height: 58, opacity: 0.5 }} />)}</div>}
          {isError && (
            <div style={errorBox}>
              <div style={{ fontSize: 22 }}>⚠</div>
              <div>
                <div style={{ fontWeight: 600 }}>백엔드(18080)에 연결하지 못했어요.</div>
                <div style={{ fontSize: 12.5, color: 'var(--fl-text-muted)', marginTop: 4 }}>백엔드를 먼저 실행하세요 — <code style={codeChip}>scripts\dev-all.ps1</code></div>
              </div>
              <button onClick={() => refetch()} style={{ ...ghostBtn, marginLeft: 'auto' }}>다시 시도</button>
            </div>
          )}
          {data && rows.length === 0 && (
            <div style={emptyBox}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>아직 실행 이력이 없습니다</div>
              <div style={{ color: 'var(--fl-text-muted)', fontSize: 13.5, marginTop: 6 }}>워크플로를 열어 <b>▶ 실행</b>하면 여기에 기록됩니다.</div>
            </div>
          )}

          <div style={{ display: 'grid', gap: 10 }}>
            {rows.map((e) => {
              const el = elapsed(e)
              return (
                <Link key={e.id} to={`/flows/${e.flowId}`} className="fl-flow-card" style={{ ...rowCard, borderLeft: `3px solid ${statusColor(e.status)}`, textDecoration: 'none', color: 'inherit' }}>
                  <StatusBadge status={e.status} />
                  <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 14.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.flowName ?? `삭제된 워크플로 (${e.flowId.slice(0, 8)})`}
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                    <span style={metaMono}>{TRIGGER_LABEL[e.trigger] ?? e.trigger}</span>
                    {el && <span style={metaMono}>{el}</span>}
                    <span style={{ ...metaMono, minWidth: 56, textAlign: 'right' }}>{relTime(e.startedAt)}</span>
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      </div>
    </AppShellTier1>
  )
}

const rowCard: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', boxShadow: 'var(--fl-shadow)' }
const metaMono: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const ghostBtn: CSSProperties = { border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '8px 14px', borderRadius: 'var(--fl-radius-sm)', fontSize: 13, cursor: 'pointer' }
const emptyBox: CSSProperties = { border: '1.5px dashed var(--fl-border)', borderRadius: 16, padding: 48, textAlign: 'center', color: 'var(--fl-text-muted)' }
const errorBox: CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, border: '1px solid var(--fl-fail)', borderRadius: 12, padding: 18, color: 'var(--fl-text)' }
const codeChip: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, background: 'var(--fl-surface-2)', padding: '1px 6px', borderRadius: 5 }
