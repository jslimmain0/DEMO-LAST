// FlowLink REST 클라이언트 — base URL 하나, JSON 왕복, 에러는 서버 메시지 그대로.
//   토큰은 요청 컨텍스트에만 있다(withToken): HTTP 요청마다 클라이언트가 보낸 Bearer(OAuth 로 받은 앱 JWT)를 실어 REST 로 그대로 넘긴다.
//   프로세스 전역 토큰은 없다 — 사용자마다 토큰이 다르다.
import { AsyncLocalStorage } from 'node:async_hooks';
export const BASE = (process.env.FLOWLINK_URL || 'http://localhost:18080').replace(/\/+$/, '');
const API = BASE + '/api/v1';
const requestCtx = new AsyncLocalStorage();
/** fn 을 주어진 토큰(null=없음)으로 실행 — 안의 모든 api()·auth.token() 이 이 토큰을 본다. */
export const withToken = (t, fn) => requestCtx.run({ token: t || null }, fn);
export const auth = { token: () => requestCtx.getStore()?.token ?? null };
export class ApiError extends Error {
    status;
    constructor(status, message) { super(message); this.status = status; }
}
export async function api(method, path, body, query) {
    const url = new URL(API + path);
    if (query)
        for (const [k, v] of Object.entries(query))
            if (v != null && v !== '')
                url.searchParams.set(k, v);
    const t = auth.token();
    const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j = null;
    try {
        j = text ? JSON.parse(text) : null;
    }
    catch { /* 비JSON 응답 */ }
    if (!r.ok)
        throw new ApiError(r.status, j?.message || j?.error || text || `HTTP ${r.status}`);
    return j;
}
export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
