import type { CSSProperties } from 'react'
import { Modal } from './Modal'

/**
 * 저장 충돌(409, 낙관적 락) 안내 — 다른 사용자가 먼저 저장한 경우.
 * 버전은 append-only 라 어느 쪽을 골라도 이력은 남는다:
 *  - 다시 저장: 내 캔버스 내용을 새 버전으로 저장(상대 변경은 이전 버전으로 남음)
 *  - 최신 불러오기: 서버 최신 버전으로 캔버스를 교체(내 미저장 변경은 사라짐)
 */
export function ConflictDialog({ onRetry, onReload, onClose }: {
  onRetry: () => void
  onReload: () => void
  onClose: () => void
}) {
  return (
    <Modal onClose={onClose} ariaLabel="저장 충돌" width="min(440px, calc(100vw - 40px))" card={{ padding: 20, display: 'block', color: 'var(--fl-text)' }}>
        <h3 style={{ margin: '0 0 8px', font: '600 15px var(--fl-font-head)' }}>다른 사용자가 먼저 저장했습니다</h3>
        <p style={{ margin: '0 0 16px', font: '13px/1.6 var(--fl-font-ui)', color: 'var(--fl-text-muted)' }}>
          이 워크플로가 방금 다른 곳에서 수정되었습니다. 버전 이력은 모두 보존되므로 어느 쪽을 선택해도 안전합니다.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button style={ghost} onClick={() => { onReload(); onClose() }}>서버 최신 버전 불러오기</button>
          <button style={primary} onClick={() => { onRetry(); onClose() }}>내 변경을 새 버전으로 저장</button>
        </div>
    </Modal>
  )
}

const ghost: CSSProperties = {
  border: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-text)',
  borderRadius: 'var(--fl-radius)', padding: '8px 12px', font: '13px var(--fl-font-ui)', cursor: 'pointer',
}
const primary: CSSProperties = {
  border: '1px solid var(--fl-primary)', background: 'var(--fl-primary)', color: '#fff',
  borderRadius: 'var(--fl-radius)', padding: '8px 12px', font: '600 13px var(--fl-font-ui)', cursor: 'pointer',
}
