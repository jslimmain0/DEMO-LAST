import type { ExecutionStatus, NodeExecutionStatus } from '../api/types'
import { AppIcon, type AppIconName } from './AppIcon'

type AnyStatus = ExecutionStatus | NodeExecutionStatus

const META: Record<string, { color: string; icon: AppIconName; label: string }> = {
  SUCCEEDED: { color: 'var(--fl-ok)', icon: 'check', label: '성공' },
  FAILED: { color: 'var(--fl-fail)', icon: 'close', label: '실패' },
  RUNNING: { color: 'var(--fl-running)', icon: 'refresh', label: '실행 중' },
  WAITING: { color: 'var(--fl-waiting)', icon: 'pause', label: '대기' },
  PENDING: { color: 'var(--fl-pending)', icon: 'clock', label: '대기열' },
  CANCELLED: { color: 'var(--fl-pending)', icon: 'stop', label: '취소됨' },
  SKIPPED: { color: 'var(--fl-pending)', icon: 'arrowRight', label: '건너뜀' },
}

// 색+아이콘+텍스트 3중 부호화 (1.4.1)
export function StatusBadge({ status }: { status: AnyStatus }) {
  const m = META[status] ?? { color: 'var(--fl-text-muted)', icon: 'more' as const, label: String(status) }
  return (
    <span
      style={{
        display: 'inline-flex',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        alignItems: 'center',
        gap: 5,
        fontFamily: 'var(--fl-font-ui)',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.4,
        color: m.color,
        background: 'color-mix(in srgb, currentColor 12%, transparent)',
        padding: '3px 8px',
        borderRadius: 'var(--fl-radius-pill)',
      }}
    >
      <AppIcon name={m.icon} size={13} />
      {m.label}
    </span>
  )
}
