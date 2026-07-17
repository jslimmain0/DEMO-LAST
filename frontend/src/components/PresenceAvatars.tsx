import { readableText } from '../lib/contrast'
import { usePresenceStore } from '../store/presenceStore'

/** 헤더 참여자 아바타 스택 — 이니셜 원, 겹침 배치, 5명 초과는 +N. */
export function PresenceAvatars() {
  const peers = usePresenceStore((s) => s.peers)
  const list = Object.values(peers)
  if (list.length === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center' }} aria-label={`함께 보는 중: ${list.map((p) => p.name).join(', ')}`}>
      {list.slice(0, 5).map((p, i) => (
        <span key={p.id} title={p.name} style={{
          width: 26, height: 26, borderRadius: '50%', background: p.color, color: readableText(p.color),
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700, border: '2px solid var(--fl-surface)',
          marginLeft: i === 0 ? 0 : -8,
        }}>{p.name.slice(0, 1).toUpperCase()}</span>
      ))}
      {list.length > 5 && (
        <span style={{ fontSize: 11, marginLeft: 4, color: 'var(--fl-text-muted)' }}>+{list.length - 5}</span>
      )}
    </div>
  )
}
