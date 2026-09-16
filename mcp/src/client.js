// FlowLink REST 클라이언트 — base URL/토큰 하나, JSON 왕복, 에러는 서버 메시지 그대로.
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
export const auth = {
    hasToken: () => !!token,
    token: () => token,
    login: () => loginName,
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
    const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
