import { useQueries } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { runsApi } from '../api/client'
import type { SuiteRunItem } from '../api/client'
import { StatusBadge } from './StatusBadge'
import { Modal } from './Modal'

/**
 * 스위트 일괄 실행 결과 매트릭스 — 각 워크플로 실행을 폴링해 성공/실패를 한눈에.
 * items 는 POST /suites/run 응답(flowId·executionId). 종료 상태까지 각 실행을 개별 폴링한다.
 */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

export function SuiteRunDialog({ items, onClose }: { items: SuiteRunItem[]; onClose: () => void }) {
  // 각 실행을 종료까지 폴링(종료면 refetch 중단)
  const results = useQueries({
    queries: items.map((it) => ({
      queryKey: ['execution', it.executionId],
      queryFn: () => runsApi.get(it.executionId as string),
      enabled: !!it.executionId,
      refetchInterval: (q: { state: { data?: { status?: string } } }) =>
        (q.state.data && TERMINAL.has(q.state.data.status ?? '')) ? false : 700,
    })),
  })

  const statusOf = (i: number): string => {
    const it = items[i]
    if (!it.executionId) return it.status // REJECTED
    return (results[i]?.data as { status?: string } | undefined)?.status ?? 'RUNNING'
  }
  const done = items.filter((_, i) => TERMINAL.has(statusOf(i)) || !items[i].executionId).length
  const okCount = items.filter((_, i) => statusOf(i) === 'SUCCEEDED').length
  const failCount = items.filter((_, i) => { const s = statusOf(i); return s === 'FAILED' || s === 'REJECTED' }).length

  return (
    <Modal onClose={onClose} ariaLabel="스위트 실행" width={560} maxWidth="96vw" maxHeight="82vh">
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <strong style={{ flex: 1, fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>스위트 실행 ({done}/{items.length})</strong>
          <span style={{ fontSize: 12, color: 'var(--fl-ok)', fontFamily: 'var(--fl-font-mono)' }}>✓ {okCount}</span>
          <span style={{ fontSize: 12, color: 'var(--fl-fail)', fontFamily: 'var(--fl-font-mono)' }}>✕ {failCount}</span>
          <button onClick={onClose} aria-label="닫기" style={xBtn}>×</button>
        </header>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && <p style={{ padding: 18, color: 'var(--fl-text-muted)', fontSize: 13 }}>실행할 워크플로가 없습니다.</p>}
          {items.map((it, i) => {
            const s = statusOf(i)
            return (
              <div key={it.flowId + i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--fl-border)' }}>
                {s === 'REJECTED'
                  ? <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-fail)' }}>거절</span>
                  : <StatusBadge status={s as never} />}
                <span style={{ flex: 1, fontFamily: 'var(--fl-font-head)', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.flowName}</span>
                {it.error && <span style={{ fontSize: 11, color: 'var(--fl-fail)' }}>{it.error}</span>}
                <Link to={`/flows/${it.flowId}`} style={{ fontSize: 11.5, color: 'var(--fl-primary)', textDecoration: 'none', fontWeight: 600 }}>편집 →</Link>
              </div>
            )
          })}
        </div>
        <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--fl-border)' }}>
          <Link to="/executions" style={{ fontSize: 12, color: 'var(--fl-text-muted)', textDecoration: 'none' }}>실행 이력에서 보기 →</Link>
          <button onClick={onClose} style={primary}>닫기</button>
        </footer>
      </Modal>
  )
}

const xBtn: CSSProperties = { width: 28, height: 28, borderRadius: 8, border: 'none', background: 'var(--fl-surface-2)', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 15 }
const primary: CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }
