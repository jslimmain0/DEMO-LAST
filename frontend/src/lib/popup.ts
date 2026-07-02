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
