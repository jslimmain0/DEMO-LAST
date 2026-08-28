import { useEffect, useRef } from 'react'

/**
 * 모달 공통: Esc 로 닫기 — 단, **가장 위에 뜬 모달만** 반응한다.
 * 워크벤치(전체화면 모달) 안에서 데이터 삽입 피커/큰 편집기를 열고 Esc 를 누르면
 * 자식만 닫혀야 하는데, 예전엔 리스너가 전부 독립이라 부모까지 같이 닫히며
 * 편집 중이던 내용/방금 받은 응답이 날아갔다. 마운트 순서 = 스택 순서.
 */
const escStack: Array<{ fire: () => void }> = []

/** Esc 스택에 핸들러 등록(비훅 API — 조건부 모달의 useEffect 안에서 사용). 반환값은 해제 함수. */
export function registerEscapeClose(onClose: () => void): () => void {
  const token = { fire: onClose }
  escStack.push(token)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && escStack[escStack.length - 1] === token) token.fire()
  }
  window.addEventListener('keydown', onKey)
  return () => {
    const i = escStack.indexOf(token)
    if (i >= 0) escStack.splice(i, 1)
    window.removeEventListener('keydown', onKey)
  }
}

export function useEscapeClose(onClose: () => void) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => registerEscapeClose(() => ref.current()), [])
}
