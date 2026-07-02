import type { CSSProperties, KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent } from 'react'
import { useCallback, useEffect, useRef } from 'react'

// 패널 사이에 끼우는 드래그 리사이즈 손잡이. axis='x'면 너비, 'y'면 높이를 조절한다.
// sign: 포인터 이동 방향 대비 크기가 커지는 방향(+1=오른쪽/아래로 끌수록 커짐, -1=왼쪽/위로 끌수록 커짐).
// setPointerCapture 로 드래그를 손잡이 요소에 고정 → 캔버스 위/창 밖/취소(pointercancel)에서도 안전하게 종료.
export function ResizeHandle({
  axis,
  sign,
  size,
  min,
  max,
  defaultSize,
  onResize,
  onResizeEnd,
  ariaLabel,
}: {
  axis: 'x' | 'y'
  sign: 1 | -1
  size: number
  min: number
  max: number
  defaultSize?: number // 더블클릭 시 되돌아갈 기본 크기
  onResize: (next: number) => void
  onResizeEnd?: (next: number) => void
  ariaLabel?: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const cleanupRef = useRef<(() => void) | null>(null)

  // 드래그 중 컴포넌트가 언마운트되어도 전역 커서/리스너가 남지 않도록 마지막에 정리
  useEffect(() => () => cleanupRef.current?.(), [])

  const onPointerDown = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      const pointerId = e.pointerId
      try {
        el.setPointerCapture(pointerId)
      } catch {
        /* 캡처 미지원 환경 무시 */
      }
      const start = axis === 'x' ? e.clientX : e.clientY
      const startSize = size
      let last = startSize
      const move = (ev: PointerEvent) => {
        const cur = axis === 'x' ? ev.clientX : ev.clientY
        last = Math.min(max, Math.max(min, startSize + sign * (cur - start)))
        onResize(last)
      }
      const end = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        try {
          el.releasePointerCapture(pointerId)
        } catch {
          /* 무시 */
        }
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        cleanupRef.current = null
        onResizeEnd?.(last)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
      cleanupRef.current = end
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [axis, sign, size, min, max, onResize, onResizeEnd],
  )

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 32 : 8
    let delta = 0
    if (axis === 'x') {
      if (e.key === 'ArrowLeft') delta = -step
      else if (e.key === 'ArrowRight') delta = step
    } else {
      if (e.key === 'ArrowUp') delta = -step
      else if (e.key === 'ArrowDown') delta = step
    }
    if (delta !== 0) {
      e.preventDefault()
      const next = clamp(size + sign * delta)
      onResize(next)
      onResizeEnd?.(next)
    }
  }

  // 더블클릭 = 기본 크기로 리셋
  const onDoubleClick = () => {
    if (defaultSize == null) return
    const next = clamp(defaultSize)
    onResize(next)
    onResizeEnd?.(next)
  }

  // 분할선(::before)을 캔버스쪽 가장자리에 붙여, 손잡이(=패널 표면색)가 패널과 이어져 보이게 한다.
  const pin = axis === 'x' ? (sign === 1 ? 'right' : 'left') : 'top'

  return (
    <div
      className="fl-resize-handle"
      data-axis={axis}
      data-pin={pin}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={ariaLabel}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={defaultSize != null ? '드래그로 크기 조절 · 더블클릭으로 기본 크기' : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
      style={axis === 'x' ? handleX : handleY}
    />
  )
}

const handleBase: CSSProperties = { flexShrink: 0, position: 'relative', zIndex: 5, touchAction: 'none', background: 'var(--fl-surface)' }
const handleX: CSSProperties = { ...handleBase, width: 10, alignSelf: 'stretch', cursor: 'col-resize' }
const handleY: CSSProperties = { ...handleBase, height: 10, cursor: 'row-resize' }
