import { useEffect } from 'react'

// 모달 공통: Esc 로 닫기. (overlay 클릭/× 버튼과 함께 WAI-ARIA dialog 관례를 맞춘다)
export function useEscapeClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
