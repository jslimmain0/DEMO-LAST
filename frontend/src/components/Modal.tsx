import type { CSSProperties, ReactNode } from 'react'
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
  children: ReactNode
}) {
  useEscapeClose(onClose)
  return (
    <div role="dialog" aria-modal="true" aria-label={ariaLabel} style={{ ...OVERLAY, zIndex }} onClick={onClose}>
      <div style={{ ...CARD, width, maxWidth, height, maxHeight, ...card }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

const OVERLAY: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const CARD: CSSProperties = { background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }
