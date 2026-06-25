import type { HttpMethod } from '../api/types'
import { METHOD_COLOR } from '../canvas/nodeMeta'

export function MethodTag({ method }: { method: HttpMethod }) {
  return (
    <span
      style={{
        fontFamily: 'var(--fl-font-mono)',
        fontSize: 10.5,
        fontWeight: 600,
        color: '#fff',
        background: METHOD_COLOR[method],
        padding: '2px 6px',
        borderRadius: 6,
        letterSpacing: '.02em',
      }}
    >
      {method}
    </span>
  )
}
