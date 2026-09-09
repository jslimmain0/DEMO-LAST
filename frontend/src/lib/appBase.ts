/**
 * 앱이 마운트된 경로 접두사(context path) — `index.html` 의 `<base href>` 에서 읽는다.
 * 서버(SpaStaticConfig)가 `server.servlet.context-path`(env `FLOWLINK_CONTEXT_PATH`)를 `<base href="/flowlink/">` 로 바꿔 넣고,
 * dev(Vite 5173)는 `<base href="/">` 그대로라 '' 이다. 라우터 basename·API baseURL·WebSocket·화면에 보여주는 절대 URL(Mock base·웹훅) 이 전부 이 값을 앞에 붙인다.
 */
export function appBase(): string {
  try {
    const p = new URL(document.baseURI).pathname
    return p.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** 오리진 + 접두사 + 경로 — 밖에 알려주는 절대 URL(`http://host/flowlink/mock/x`). */
export function appUrl(path: string): string {
  return `${window.location.origin}${appBase()}${path.startsWith('/') ? path : `/${path}`}`
}
