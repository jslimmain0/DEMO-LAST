import type { HttpMethod } from '../api/types'
import { METHOD_COLOR } from '../canvas/nodeMeta'
import { useReadableInk } from '../lib/contrast'

export function MethodTag({ method }: { method: HttpMethod }) {
  const ink = useReadableInk(METHOD_COLOR[method])
  return (
    <span
      style={{
        fontFamily: 'var(--fl-font-mono)',
        fontSize: 10.5,
        fontWeight: 600,
        color: ink,
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
