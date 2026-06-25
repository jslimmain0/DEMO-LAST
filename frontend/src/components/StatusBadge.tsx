import type { ExecutionStatus, NodeExecutionStatus } from '../api/types'

type AnyStatus = ExecutionStatus | NodeExecutionStatus

const META: Record<string, { color: string; icon: string; label: string }> = {
  SUCCEEDED: { color: 'var(--fl-ok)', icon: '✓', label: '성공' },
  FAILED: { color: 'var(--fl-fail)', icon: '✕', label: '실패' },
  RUNNING: { color: 'var(--fl-running)', icon: '◴', label: '실행중' },
  WAITING: { color: 'var(--fl-waiting)', icon: '⏸', label: '대기' },
  PENDING: { color: 'var(--fl-pending)', icon: '○', label: '대기열' },
  CANCELLED: { color: 'var(--fl-pending)', icon: '⊘', label: '취소됨' },
  SKIPPED: { color: 'var(--fl-pending)', icon: '–', label: '건너뜀' },
}

// 색+아이콘+텍스트 3중 부호화 (1.4.1)
export function StatusBadge({ status }: { status: AnyStatus }) {
  const m = META[status] ?? { color: 'var(--fl-text-muted)', icon: '·', label: String(status) }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11.5,
        fontWeight: 600,
        color: m.color,
        background: 'color-mix(in srgb, currentColor 12%, transparent)',
        padding: '3px 9px',
        borderRadius: 'var(--fl-radius-pill)',
      }}
    >
      <span aria-hidden>{m.icon}</span>
      {m.label}
    </span>
  )
}
