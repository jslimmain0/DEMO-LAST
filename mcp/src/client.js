// FlowLink REST 클라이언트 — base URL/토큰 하나, JSON 왕복, 에러는 서버 메시지 그대로.
//   토큰 출처는 두 겹: ① 요청 컨텍스트(HTTP 모드 — 클라이언트가 보낸 Authorization 헤더, withToken()) ② 프로세스 전역(stdio 모드 —
//   FLOWLINK_TOKEN env 또는 ~/.flowlink/mcp-token.json). ①이 있으면 ①, 없으면 ②. HTTP 모드는 사용자마다 토큰이 달라 전역에 둘 수 없다.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const BASE = (process.env.FLOWLINK_URL || 'http://localhost:18080').replace(/\/+$/, '');
const API = BASE + '/api/v1';
const CACHE_DIR = join(homedir(), '.flowlink');
const CACHE = join(CACHE_DIR, 'mcp-token.json');
let token = process.env.FLOWLINK_TOKEN || null;
let loginName = null;
if (!token) {
    try {
        const c = JSON.parse(readFileSync(CACHE, 'utf8'));
        if (c.url === BASE && c.token) {
            token = c.token;
            loginName = c.login ?? null;
        }
    }
    catch { /* 캐시 없음 */ }
}
/** 요청 단위 토큰 컨텍스트(HTTP 모드). 스토어가 있으면 그 토큰이 전역 토큰보다 우선한다(빈 문자열도 "이 요청은 토큰 없음"으로 존중). */
const requestCtx = new AsyncLocalStorage();
/** fn 을 주어진 토큰(null=없음)으로 실행 — HTTP 모드에서 요청마다 호출. 안의 모든 api()·auth.* 가 이 토큰을 본다. */
export const withToken = (t, fn) => requestCtx.run({ token: t || null }, fn);
const current = () => { const s = requestCtx.getStore(); return s ? s.token : token; };
export const auth = {
    hasToken: () => !!current(),
    token: () => current(),
    /** 로그인명 — stdio 캐시에만 있다(HTTP 모드는 서버 /admin/me 로 확인). */
    login: () => (requestCtx.getStore() ? null : loginName),
    set(t, l) {
        token = t;
        loginName = l;
        try {
            mkdirSync(CACHE_DIR, { recursive: true });
            writeFileSync(CACHE, JSON.stringify({ url: BASE, token: t, login: l, at: new Date().toISOString() }));
        }
        catch { /* 캐시 실패는 무시 */ }
    },
    clear() { token = null; loginName = null; try {
        writeFileSync(CACHE, '{}');
    }
    catch { /* */ } },
};
export class ApiError extends Error {
    status;
    constructor(status, message) { super(message); this.status = status; }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(method, path, body, query) {
    const url = new URL(API + path);
    if (query)
        for (const [k, v] of Object.entries(query))
            if (v != null && v !== '')
                url.searchParams.set(k, v);
    const t = current();
    const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
