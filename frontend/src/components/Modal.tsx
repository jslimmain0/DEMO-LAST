import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { useEscapeClose } from './useEscapeClose'

/**
 * 공용 모달 셸 — overlay + card + Esc 닫기 + 배경 클릭 닫기 + z-index 를 한 곳에서 처리.
 * 헤더/본문/푸터 등 내용은 children 이 그대로 렌더한다(각 다이얼로그의 레이아웃 자유). 7+ 다이얼로그의
 * `position:fixed; inset:0; …` overlay/card 복붙과 useEscapeClose 를 통합.
 */
export function Modal({
  onClose,
  ariaLabel,
  width = 520,
  maxWidth = '96vw',
  height,
  maxHeight = '90vh',
  zIndex = 200,
  card,
  closeOnBackdrop = true,
  onKeyDown,
  children,
}: {
  onClose: () => void
  ariaLabel: string
  width?: number | string
  maxWidth?: number | string
  height?: number | string
  maxHeight?: number | string
  zIndex?: number
  card?: CSSProperties // 카드 스타일 오버라이드(패딩·flex 등)
  closeOnBackdrop?: boolean // 배경 클릭으로 닫기(기본 true). 입력 유실 방지가 필요하면 false.
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void // 카드 keydown(예: Enter 확인)
  children: ReactNode
}) {
  useEscapeClose(onClose)
  const cardRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const previous = previousFocus.current
    const card = cardRef.current
    if (!card) return
    if (!card.contains(document.activeElement)) (card.querySelector<HTMLElement>('input, select, textarea, button, [tabindex="0"]') ?? card).focus({ preventScroll: true })
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const elements = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"], [contenteditable="true"]') ?? [])
      .filter(el => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true')
    const first = elements[0], last = elements.at(-1)
    if (!first) { event.preventDefault(); cardRef.current?.focus(); return }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  const bounded = (value: number | string, viewport: 'vw' | 'dvh') => `min(${typeof value === 'number' ? `${value}px` : value}, calc(100${viewport} - var(--fl-modal-gutter) - var(--fl-modal-gutter)))`
  const dimensions: CSSProperties = { width, height, ...card,
    maxWidth: bounded(card?.maxWidth ?? maxWidth, 'vw'),
    maxHeight: bounded(card?.maxHeight ?? maxHeight, 'dvh'),
  }
  return (
    <div role="dialog" aria-modal="true" aria-label={ariaLabel} className="fl-modal-overlay" style={{ zIndex }} onClick={closeOnBackdrop ? onClose : undefined}>
      <div ref={cardRef} tabIndex={-1} className="fl-modal-card" style={dimensions} onClick={(e) => e.stopPropagation()} onKeyDown={handleKey}>
        {children}
      </div>
    </div>
  )
}
