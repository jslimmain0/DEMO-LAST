import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

interface Rect { left: number; top: number; right: number; bottom: number }
interface Viewport { left: number; top: number; width: number; height: number }
interface Position { left: number; top: number; width: number; maxHeight: number }

/** Fixed body-portal coordinates; constrain the popup itself, not only its width. */
export function anchoredPosition(anchor: Rect, viewport: Viewport, desiredWidth: number, desiredHeight: number, gap = 6, margin = 12): Position {
  const width = Math.max(1, Math.min(desiredWidth, viewport.width - margin * 2))
  const leftEdge = viewport.left + margin, rightEdge = viewport.left + viewport.width - margin
  const topEdge = viewport.top + margin, bottomEdge = viewport.top + viewport.height - margin
  const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width))
  const below = Math.max(0, bottomEdge - Math.max(topEdge, anchor.bottom + gap))
  const above = Math.max(0, Math.min(bottomEdge, anchor.top - gap) - topEdge)
  const flip = desiredHeight > below && above > below
  const maxHeight = Math.max(1, flip ? above : below)
  const height = Math.min(desiredHeight, maxHeight)
  const proposedTop = flip ? anchor.top - gap - height : anchor.bottom + gap
  const top = Math.max(topEdge, Math.min(proposedTop, bottomEdge - height))
  return { left, top, width, maxHeight }
}

/** The caller portals its popup to body; anchor and popup observers keep that boundary accurate. */
export function useAnchoredPopover(anchorRef: RefObject<HTMLElement | null>, open: boolean, width = 300) {
  const popupRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<Position | null>(null)
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const anchor = anchorRef.current, popup = popupRef.current
    if (!anchor || !popup) return
    const update = () => {
      const visual = window.visualViewport
      const viewport = { left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0,
        width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight }
      const next = anchoredPosition(anchor.getBoundingClientRect(), viewport, width, popup.scrollHeight)
      setPosition(current => current && Object.keys(next).every(key => current[key as keyof Position] === next[key as keyof Position]) ? current : next)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(anchor); observer?.observe(popup)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    }
  }, [anchorRef, open, width])
  const style: CSSProperties = { position: 'fixed', boxSizing: 'border-box',
    ...(position ?? { left: 0, top: 0, width, visibility: 'hidden' }), overflowY: 'auto' }
  return { popupRef, style, ready: position !== null }
}
