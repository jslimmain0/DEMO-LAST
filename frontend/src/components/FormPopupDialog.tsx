import type { CSSProperties } from 'react'
import type { PendingFormRequest } from '../api/types'
import { useEscapeClose } from './useEscapeClose'

/**
 * 실행 중 '폼 전송' 노드에서 뜨는 안내 — fire-and-forget.
 * 버튼(사용자 제스처)으로 새 팝업을 열고, 팝업 안에 "이동 중…" 화면과 hidden form 을 써넣어 자동 submit 한다.
 * 결제창/인증창이 팝업 안에 로드되면 이 노드는 끝 — 기다리는 것은 다음 '콜백 대기' 노드의 몫.
 * 창 이름이 노드별로 고정(flowlink_pay_{노드ID})이라 재실행 시 같은 창을 재사용한다.
 */
export function FormPopupDialog({
  form,
  onDone,
  onCancel,
}: {
  form: PendingFormRequest
  onDone: (error: string | null) => void // null=submit 완료, 문자열=실패(팝업 차단 등 → 노드 실패)
  onCancel: () => void
}) {
  useEscapeClose(onCancel)

  const openPopup = () => {
    const popup = window.open('', 'flowlink_pay_' + form.nodeId, 'width=480,height=720')
    if (!popup) {
      onDone('팝업 차단됨 — 브라우저의 팝업 허용이 필요합니다')
      return
    }
    const method = (form.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST'
    const inputs = (form.fields ?? [])
      .map((f) => `<input type="hidden" name="${esc(f.key)}" value="${esc(f.value ?? '')}">`)
      .join('')
    popup.document.open()
    popup.document.write(
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>이동 중…</title></head>'
      + '<body style="font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#333">'
      + '<p>이동 중…</p>'
      + `<form id="f" method="${method}" action="${esc(form.action)}">${inputs}</form>`
      + '</body></html>',
    )
    popup.document.close()
    const f = popup.document.getElementById('f') as HTMLFormElement | null
    if (!f) {
      onDone('팝업 폼 조립에 실패했습니다')
      return
    }
    f.submit()
    onDone(null) // submit 직후 성공 처리 → 실행은 다음 노드로 진행
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
          <p style={{ fontSize: 13, color: 'var(--fl-text)', margin: '0 0 10px', lineHeight: 1.5 }}>
            새 창(팝업)으로 아래 주소에 폼을 전송합니다. 전송 후 실행은 바로 다음 노드로 진행됩니다.
          </p>
          <div style={{ fontFamily: 'var(--fl-font-mono)', fontSize: 12, padding: '8px 10px', background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius-sm)', wordBreak: 'break-all' }}>
            <b>{form.method}</b> {form.action || '(URL 미설정)'}
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 8 }}>{(form.fields ?? []).length}개 필드 전송</p>
        </div>

        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--fl-border)' }}>
          <button onClick={onCancel} style={ghost}>취소</button>
          <button onClick={openPopup} style={primary}>폼 창 열기</button>
        </footer>
      </div>
    </div>
  )
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(26,29,39,.45)', zIndex: 210, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }
const card: CSSProperties = { width: 440, maxWidth: '100%', background: 'var(--fl-surface)', borderRadius: 'var(--fl-radius-lg)', boxShadow: 'var(--fl-shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const primary: CSSProperties = { padding: '9px 18px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const ghost: CSSProperties = { padding: '9px 16px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 13, cursor: 'pointer' }
