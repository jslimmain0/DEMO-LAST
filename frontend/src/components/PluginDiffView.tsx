import { useMemo } from 'react'
import { lineDiff } from '../lib/lineDiff'

/** 승인본(왼쪽 기준) 대비 초안 — 삭제 줄 빨강, 추가 줄 초록. 승인 화면과 편집기 '승인본과 비교' 가 공용. */
export function PluginDiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after])
  const changed = lines.filter((l) => l.type !== 'same').length
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', fontFamily: 'var(--fl-font-mono)', fontSize: 12.5, lineHeight: 1.6 }}>
      <div style={{ padding: '6px 12px', fontSize: 11.5, color: 'var(--fl-text-muted)', borderBottom: '1px solid var(--fl-border)', position: 'sticky', top: 0, background: 'var(--fl-surface)' }}>
        {changed === 0 ? '승인본과 동일' : `승인본 대비 ${lines.filter((l) => l.type === 'add').length}줄 추가 · ${lines.filter((l) => l.type === 'del').length}줄 삭제`}
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '0 12px', whiteSpace: 'pre', background: l.type === 'add' ? 'color-mix(in srgb, var(--fl-ok) 14%, transparent)' : l.type === 'del' ? 'color-mix(in srgb, var(--fl-fail) 14%, transparent)' : 'transparent' }}>
          <span style={{ width: 12, color: 'var(--fl-text-muted)', userSelect: 'none' }}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
          <span style={{ textDecoration: l.type === 'del' ? 'line-through' : 'none', opacity: l.type === 'del' ? 0.8 : 1 }}>{l.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
