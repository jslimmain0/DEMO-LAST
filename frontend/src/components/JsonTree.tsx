import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'

/**
 * 클릭 가능한 JSON 트리 — 워크벤치 응답 패널에서 중첩 JSON 을 펼쳐 보고,
 * 행을 클릭하면 그 값의 <b>경로 토큰</b>({{ user.name@노드 }}·{{ items[0].id@노드 }})을 집는다.
 * JSON 안의 JSON 을 "복사해서 손으로 경로 조립"하지 않게 하는 장치.
 */
export function JsonTree({
  value,
  onPick,
  depth = 0,
  path = '',
  defaultOpenDepth = 2,
}: {
  value: unknown
  onPick?: (path: string, value: unknown) => void
  depth?: number
  path?: string
  defaultOpenDepth?: number
}) {
  if (value !== null && typeof value === 'object') {
    const entries: Array<[string, unknown, string]> = Array.isArray(value)
      ? value.map((v, i) => [`[${i}]`, v, path ? `${path}[${i}]` : `[${i}]`] as [string, unknown, string])
      : Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v, path ? `${path}.${k}` : k] as [string, unknown, string])
    if (entries.length === 0) {
      return <span style={muted}>{Array.isArray(value) ? '[]' : '{}'}</span>
    }
    return (
      <div style={depth > 0 ? { borderLeft: '1px solid var(--fl-border)', marginLeft: 5, paddingLeft: 10 } : undefined}>
        {entries.map(([label, v, p]) => (
          <TreeRow key={p} label={label} value={v} path={p} depth={depth} onPick={onPick} defaultOpenDepth={defaultOpenDepth} />
        ))}
      </div>
    )
  }
  return <Leaf v={value} />
}

function TreeRow({ label, value, path, depth, onPick, defaultOpenDepth }: {
  label: string
  value: unknown
  path: string
  depth: number
  onPick?: (path: string, value: unknown) => void
  defaultOpenDepth: number
}) {
  const isObj = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth + 1 < defaultOpenDepth)
  const count = isObj ? (Array.isArray(value) ? value.length : Object.keys(value as object).length) : 0

  return (
    <div>
      <div className="fl-jt-row" style={row}>
        {isObj ? (
          <button aria-label={open ? '접기' : '펼치기'} onClick={() => setOpen((v) => !v)} style={caret}>{open ? '▾' : '▸'}</button>
        ) : (
          <span style={{ ...caret, visibility: 'hidden' }}>·</span>
        )}
        <button
          className="fl-jt-key"
          title={onPick ? `클릭: {{ ${path}@… }} 토큰 사용` : path}
          onClick={onPick ? () => onPick(path, value) : undefined}
          style={keyBtn}
        >{label}</button>
        <span style={muted}>:</span>
        {isObj ? (
          <span style={muted}>{Array.isArray(value) ? `배열 [${count}]` : `객체 {${count}}`}{!open && ' …'}</span>
        ) : (
          <Leaf v={value} />
        )}
      </div>
      {isObj && open && (
        <JsonTree value={value} onPick={onPick} depth={depth + 1} path={path} defaultOpenDepth={defaultOpenDepth} />
      )}
    </div>
  )
}

function Leaf({ v }: { v: unknown }): ReactNode {
  if (v === null) return <span style={{ ...leaf, color: 'var(--fl-text-muted)' }}>null</span>
  switch (typeof v) {
    case 'string': return <span style={{ ...leaf, color: 'var(--fl-ok)' }}>"{v.length > 120 ? v.slice(0, 120) + '…' : v}"</span>
    case 'number': return <span style={{ ...leaf, color: 'var(--fl-put)' }}>{String(v)}</span>
    case 'boolean': return <span style={{ ...leaf, color: 'var(--fl-patch, #7c3aed)' }}>{String(v)}</span>
    default: return <span style={leaf}>{String(v)}</span>
  }
}

const row: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 5, padding: '1.5px 0', minWidth: 0 }
const caret: CSSProperties = { flexShrink: 0, width: 14, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 9, padding: 0, lineHeight: 1.4 }
const keyBtn: CSSProperties = { flexShrink: 0, border: 'none', background: 'transparent', padding: '0 2px', margin: 0, fontFamily: 'var(--fl-font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--fl-primary)', cursor: 'pointer', borderRadius: 4 }
const muted: CSSProperties = { color: 'var(--fl-text-muted)', fontSize: 11.5, fontFamily: 'var(--fl-font-mono)' }
const leaf: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 12, overflowWrap: 'anywhere', minWidth: 0 }
