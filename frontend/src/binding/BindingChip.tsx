import type { Binding } from '../api/types'
import { catColor, typeIcon } from '../canvas/nodeMeta'

// 닫힌 칩 — sourceId 와 {{ }} 표기는 숨기고 노드 이름·키만 보여준다 (UI/UX 스펙 §7.2).
export function BindingChip({
  binding,
  sourceType,
  onRemove,
  onClick,
}: {
  binding: Binding
  sourceType?: string
  onRemove?: () => void
  onClick?: () => void
}) {
  const accent = catColor(binding.cat)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 6px 5px 9px',
        borderRadius: 'var(--fl-radius-pill)',
        border: `1px solid ${accent}`,
        background: 'color-mix(in srgb, ' + 'var(--fl-surface-2)' + ' 60%, transparent)',
        fontSize: 12,
        maxWidth: '100%',
      }}
    >
      <span aria-hidden style={{ color: accent }}>{typeIcon(sourceType ?? 'http')}</span>
      <button
        onClick={onClick}
        title={`${binding.nodeName ?? binding.sourceId} · ${binding.key}`}
        style={{ border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', padding: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}
      >
        <span style={{ color: 'var(--fl-text-muted)' }}>{binding.nodeName ?? binding.sourceId}</span>
        {binding.scope === 'req' && <span style={{ color: 'var(--fl-text-muted)', fontSize: 10 }}> (요청)</span>}
        {' · '}
        <strong style={{ fontFamily: 'var(--fl-font-mono)' }}>{binding.key}</strong>
      </button>
      {onRemove && (
        <button onClick={onRemove} aria-label="바인딩 제거" style={{ border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
      )}
    </span>
  )
}
