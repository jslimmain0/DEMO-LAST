// form(폼 전송) 노드 — 팝업을 열고 hidden form 을 자동 submit 한다. 기다리지 않는다(fire-and-forget).
import type { PendingFormRequest } from '../api/types'

/**
 * 창 이름이 노드별로 고정이라 재실행하면 새 창이 아니라 같은 창을 재사용한다.
 * 제출은 opener(현재 문서)에서 target=창이름 으로 한다 — 재사용 창이 교차출처(게이트웨이)로
 * 이동해 있어도 이름으로 안전하게 전송된다(popup.document 접근은 SecurityError). DOM 조립이라
 * 값 이스케이프 문제도 없다. "이동 중…" 화면은 새(about:blank) 창일 때만 그린다.
 *
 * @returns null=성공(팝업 열고 submit 완료), 문자열=실패 사유(팝업 차단 등)
 */
export function openFormPopup(form: PendingFormRequest): string | null {
  const name = 'flowlink_pay_' + form.nodeId
  const popup = window.open('', name, 'width=480,height=720')
  if (!popup) {
    return '팝업 차단됨 — 브라우저의 팝업 허용이 필요합니다.'
  }
  try {
    // 새 창(동일출처 about:blank)일 때만 인터스티셜 — 교차출처 재사용 창이면 여기서 throw → 건너뜀
    if (popup.location.href === 'about:blank') {
      const doc = popup.document
      doc.open()
      doc.write(
        '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>이동 중…</title></head>'
        + '<body style="font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#333;">이동 중…</body></html>',
      )
      doc.close()
    }
  } catch {
    /* 교차출처로 이동해 있는 재사용 창 — target 제출은 이름으로 동작하므로 무시 */
  }
  try {
    const f = document.createElement('form')
    f.method = (form.method || 'POST').toUpperCase() === 'GET' ? 'get' : 'post'
    f.action = form.action
    f.target = name
    f.style.display = 'none'
    for (const fd of form.fields ?? []) {
      if (!fd.key) continue
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = fd.key
      input.value = fd.value ?? ''
      f.appendChild(input)
    }
    document.body.appendChild(f)
    try {
      f.submit()
    } finally {
      document.body.removeChild(f)
    }
    try {
      popup.focus()
    } catch {
      /* 포커스 실패 무시 */
    }
    return null
  } catch (e) {
    return '팝업 form 제출 실패: ' + (e instanceof Error ? e.message : String(e))
  }
}

/**
 * iframe 모드 — 팝업 창 대신 페이지 내 모달 오버레이 안의 iframe 으로 form 을 제출한다.
 * 팝업 차단이 없고, 결제창이 같은 페이지에 뜬다. 결제창(iframe)이 콜백을 쏘면 wait 노드가 재개하고,
 * 결제창이 `postMessage('fl-close')` 하거나 사용자가 ✕/바깥을 누르면 모달이 닫힌다.
 *
 * @returns null=성공, 문자열=실패 사유
 */
export function openFormIframe(form: PendingFormRequest): string | null {
  try {
    const iname = 'flowlink_iframe_' + form.nodeId
    document.getElementById('fl-iframe-ov-' + form.nodeId)?.remove() // 재실행 시 이전 모달 정리
    const ov = document.createElement('div')
    ov.id = 'fl-iframe-ov-' + form.nodeId
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center'
    const modal = document.createElement('div')
    modal.style.cssText = 'width:480px;height:720px;max-width:94vw;max-height:90vh;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.45);display:flex;flex-direction:column'
    const bar = document.createElement('div')
    bar.style.cssText = 'height:40px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 14px;background:#f5f5f7;border-bottom:1px solid #e5e5e7;font:600 13px system-ui,sans-serif;color:#333'
    const title = document.createElement('span')
    title.textContent = '결제창 (iframe)'
    const close = document.createElement('button')
    close.textContent = '✕'
    close.setAttribute('aria-label', '닫기')
    close.style.cssText = 'width:28px;height:28px;border:none;background:transparent;cursor:pointer;font-size:15px;color:#666'
    const cleanup = () => { ov.remove(); window.removeEventListener('message', onMsg) }
    close.onclick = cleanup
    bar.appendChild(title)
    bar.appendChild(close)
    const iframe = document.createElement('iframe')
    iframe.name = iname
    iframe.style.cssText = 'flex:1;width:100%;border:none'
    modal.appendChild(bar)
    modal.appendChild(iframe)
    ov.appendChild(modal)
    ov.onclick = (e) => { if (e.target === ov) cleanup() }
    const onMsg = (e: MessageEvent) => {
      if (e.data === 'fl-close' || e.data === 'fl-close-' + form.nodeId) cleanup()
    }
    window.addEventListener('message', onMsg)
    document.body.appendChild(ov)

    const f = document.createElement('form')
    f.method = (form.method || 'POST').toUpperCase() === 'GET' ? 'get' : 'post'
    f.action = form.action
    f.target = iname
    f.style.display = 'none'
    for (const fd of form.fields ?? []) {
      if (!fd.key) continue
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = fd.key
      input.value = fd.value ?? ''
      f.appendChild(input)
    }
    document.body.appendChild(f)
    try {
      f.submit()
    } finally {
      document.body.removeChild(f)
    }
    return null
  } catch (e) {
    return 'iframe form 제출 실패: ' + (e instanceof Error ? e.message : String(e))
  }
}
