import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { runsApi } from '../api/client'
import { AppShellTier1 } from '../app/AppShell'
import { StatusBadge } from '../components/StatusBadge'
import { relTime } from '../lib/format'

export function Executions() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['executions'], queryFn: () => runsApi.recent(50) })
  return (
    <AppShellTier1>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: 40 }}>
        <h1 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 28, marginBottom: 18 }}>실행 이력</h1>
        {isLoading && <p style={{ color: 'var(--fl-text-muted)' }}>불러오는 중…</p>}
        {isError && <p style={{ color: 'var(--fl-fail)' }}>백엔드(18080) 연결 실패.</p>}
        {data && data.length === 0 && <p style={{ color: 'var(--fl-text-muted)' }}>실행 이력이 없습니다.</p>}
        {data && data.map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px', borderBottom: '1px solid var(--fl-border)' }}>
            <StatusBadge status={e.status} />
            <Link to={`/flows/${e.flowId}`} style={{ color: 'var(--fl-text)', fontFamily: 'var(--fl-font-mono)', fontSize: 13, textDecoration: 'none' }}>{e.flowId}</Link>
            <span style={{ marginLeft: 'auto', color: 'var(--fl-text-muted)', fontSize: 12 }}>{relTime(e.startedAt)}</span>
          </div>
        ))}
      </div>
    </AppShellTier1>
  )
}
