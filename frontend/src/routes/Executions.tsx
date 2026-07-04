import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { flowsApi, runsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { StatusBadge } from '../components/StatusBadge'
import { relTime } from '../lib/format'

export function Executions() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['executions'], queryFn: () => runsApi.recent(50) })
  // 사람이 못 읽는 flowId(UUID) 대신 워크플로 이름을 보여준다 — flows 목록과 조인.
  const flows = useQuery({ queryKey: ['flows'], queryFn: flowsApi.list })
  // 현재 플로우면 이름, 삭제된 플로우면 최소한 구분되도록 짧은 식별자로 폴백.
  const nameOf = (flowId: string) =>
    flows.data?.find((f) => f.id === flowId)?.name ?? `삭제된 워크플로 (${flowId.slice(0, 8)})`
  return (
    <AppShellTier1>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: 40 }}>
        <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 'var(--fl-fs-2xl)', marginBottom: 18 }}>실행 이력</h1>
        {isLoading && <p style={{ color: 'var(--fl-text-muted)' }}>불러오는 중…</p>}
        {isError && <p style={{ color: 'var(--fl-fail)' }}>백엔드(18080)에 연결하지 못했습니다. 백엔드를 먼저 실행하세요.</p>}
        {data && data.length === 0 && (
          <p style={{ color: 'var(--fl-text-muted)' }}>아직 실행 이력이 없습니다. 워크플로를 열어 ▶ 실행하면 여기에 기록됩니다.</p>
        )}
        {data && data.map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: '1px solid var(--fl-border)' }}>
            <StatusBadge status={e.status} />
            <Link to={`/flows/${e.flowId}`} style={{ color: 'var(--fl-text)', fontSize: 14, fontWeight: 500, textDecoration: 'none' }}>{nameOf(e.flowId)}</Link>
            <span style={{ marginLeft: 'auto', color: 'var(--fl-text-muted)', fontSize: 12 }}>{relTime(e.startedAt)}</span>
          </div>
        ))}
      </div>
    </AppShellTier1>
  )
}
