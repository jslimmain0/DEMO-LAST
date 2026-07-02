import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { PendingFormRequest } from '../api/types'
import { useEscapeClose } from './useEscapeClose'

// 실행 중 '폼 전송' 노드에서 뜨는 안내. 버튼(사용자 제스처)으로 새 창(팝업)을 열고 폼을 target 전송한 뒤,
// 팝업이 postMessage 로 결과를 보내거나 창이 닫히면 그 값으로 실행을 재개한다.
export function FormPopupDialog({
  form,
  onResult,
  onCancel,
}: {
  form: PendingFormRequest
  onResult: (values: Record<string, unknown>) => void
  onCancel: () => void
}) {
  const [opened, setOpened] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  useEscapeClose(onCancel)
  useEffect(() => () => cleanupRef.current?.(), []) // 언마운트 시 리스너/타이머 정리

  const openPopup = () => {
    cleanupRef.current?.() // 재열기('다시 열기') 시 이전 리스너/타이머 정리(누수 방지)
    cleanupRef.current = null
    const name = 'flowlink_form_' + form.nodeId
    const popup = window.open('', name, 'width=480,height=640,resizable=yes,scrollbars=yes')
    if (!popup) {
      setBlocked(true)
      return
    }
    // 폼을 조립해 팝업 창으로 target 전송
    const f = document.createElement('form')
    f.method = (form.method || 'POST').toUpperCase()
    f.action = form.action
    f.target = name
    for (const fd of form.fields ?? []) {
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = fd.key
      input.value = fd.value ?? ''
      f.appendChild(input)
    }
    document.body.appendChild(f)
    f.submit()
    document.body.removeChild(f)
    setOpened(true)
    setBlocked(false)

    // 결과 대기: 팝업의 postMessage(구조화 결과) 또는 창 닫힘
    let done = false
    const finish = (data: Record<string, unknown>) => {
      if (done) return
      done = true
      cleanupRef.current?.()
      cleanupRef.current = null
      onResult(data)
    }
    const onMsg = (e: MessageEvent) => {
      if (e.source !== popup) return
      const d = e.data
      // 팝업이 게이트웨이로 교차출처 이동한 뒤에도 e.source===popup 은 유지되므로, 게이트웨이 페이지의
      // SDK/애널리틱스 등이 보내는 임의 postMessage 로 조기 재개되지 않도록 필터:
      //  - 콜백 브리지 마커(__flcallback) 가 있거나
      //  - 동일 출처(우리 오리진의 커스텀 폼 target)인 경우만 결과로 인정
      const isBridge = !!d && typeof d === 'object' && (d as Record<string, unknown>).__flcallback === true
      const sameOrigin = e.origin === window.location.origin
      if (!isBridge && !sameOrigin) return
      if (d && typeof d === 'object') {
        const obj = { ...(d as Record<string, unknown>) }
        delete obj.__flcallback // 마커는 제거하고 결과 값만 전달
        finish(obj)
      } else {
        finish({ result: d })
      }
    }
    window.addEventListener('message', onMsg)
    const timer = window.setInterval(() => {
      if (popup.closed) finish({ closed: true })
    }, 500)
    cleanupRef.current = () => {
      window.removeEventListener('message', onMsg)
      window.clearInterval(timer)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="폼 전송" style={overlay}>
      <div style={card}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--fl-border)' }}>
          <span aria-hidden style={{ color: 'var(--fl-cat-wait)', fontSize: 16 }}>▤</span>
          <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 15 }}>{form.nodeName || '폼 전송'}</strong>
          <button onClick={onCancel} aria-label="취소" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </header>

        <div style={{ padding: 18 }}>
          <p style={{ fontSize: 13, color: 'var(--fl-text)', margin: '0 0 10px', lineHeight: 1.5 }}>새 창(팝업)으로 아래 주소에 폼을 전송합니다.</p>
          <div style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: '8px 10px', background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius-sm)', wordBreak: 'break-all' }}>
            <b>{form.method}</b> {form.action || '(URL 미설정)'}
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>{(form.fields ?? []).length}개 필드 전송</p>
          {blocked && <p style={{ fontSize: 12.5, color: 'var(--fl-fail)', marginTop: 8 }}>⚠ 팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 눌러주세요.</p>}
          {opened && <p style={{ fontSize: 12.5, color: 'var(--fl-running)', marginTop: 8 }} role="status">창에서 완료를 기다리는 중… (팝업이 결과를 보내거나 닫히면 자동 진행됩니다)</p>}
        </div>

        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--fl-border)' }}>
          <button onClick={onCancel} style={ghost}>취소</button>
          <button onClick={openPopup} style={primary}>{opened ? '다시 열기' : '폼 창 열기'}</button>
        </footer>
      </div>
    </div>
  )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.45)', zIndex: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 440, maxWidth: '100%', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const primary: CSSProperties = { padding: '9px 18px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const ghost: CSSProperties = { padding: '9px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer' }
