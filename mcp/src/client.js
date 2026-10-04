// FlowLink REST 클라이언트 — base URL 하나, JSON 왕복, 에러는 서버 메시지 그대로.
//   토큰은 요청 컨텍스트에만 있다(withToken): HTTP 요청마다 클라이언트가 보낸 Bearer(OAuth 로 받은 앱 JWT)를 실어 REST 로 그대로 넘긴다.
//   프로세스 전역 토큰은 없다 — 사용자마다 토큰이 다르다.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
const agentIndex = process.argv.indexOf('--agent-file');
const agentFile = agentIndex < 0 ? null : process.argv[agentIndex + 1];
if (agentIndex >= 0 && (!agentFile || !process.argv.includes('--stdio'))) throw new Error('개인 에이전트 연결은 --stdio와 --agent-file 경로를 함께 사용하세요.');
const agent = () => {
    if (!agentFile) return null;
    const value = JSON.parse(readFileSync(agentFile, 'utf8'));
    const u = new URL(value.baseUrl);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
        throw new Error('개인 에이전트 주소는 loopback HTTP 주소여야 합니다.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('개인 에이전트 연결 정보가 올바르지 않습니다. 트레이에서 다시 시작하세요.');
    return value;
};
const initialAgent = agent();
export const BASE = (initialAgent?.baseUrl || process.env.FLOWLINK_URL || 'http://localhost:18080').replace(/\/+$/, '');
export const remote = process.argv.includes('--target') && process.argv[process.argv.indexOf('--target') + 1] === 'server';
if (remote && !agentFile) throw new Error('서버 연결은 Windows 앱의 --agent-file을 사용하세요.');
export const desktopAgent = !!agentFile;
const requestCtx = new AsyncLocalStorage();
/** fn 을 주어진 토큰(null=없음)으로 실행 — 안의 모든 api()·auth.token() 이 이 토큰을 본다. */
export const withToken = (t, fn) => requestCtx.run({ ...requestCtx.getStore(), token: t || null }, fn);
export const auth = { token: () => requestCtx.getStore()?.token ?? null };
export const currentTarget = () => requestCtx.getStore()?.target ?? (desktopAgent && !remote ? 'local' : 'server');
export const currentWorkspace = () => requestCtx.getStore()?.workspaceId ?? null;
export const resourceBase = () => requestCtx.getStore()?.serverUrl ?? BASE;
export const withWorkspace = (workspaceId, fn) => requestCtx.run({ ...requestCtx.getStore(), workspaceId }, fn);
/** One tool invocation keeps its destination/account even if the tray changes connection during polling. */
export const withTarget = (target, fn) => {
    const destination = target ?? currentTarget();
    if (destination === 'local' && !desktopAgent) throw new Error('내 PC 접근은 Windows 앱이 등록한 MCP 연결에서만 가능합니다.');
    const context = { ...requestCtx.getStore(), target: destination, workspaceId: null, login: null, serverUrl: null };
    return requestCtx.run(context, async () => {
        if (desktopAgent && destination === 'server') {
            const connection = await requestCtx.run({ ...context, target: 'local' }, () => api('GET', '/desktop/connection'));
            if (!connection.connected || !connection.login) throw new Error('Windows 앱의 서버 연결에서 로그인하세요. 개인 공간은 target="local"로 계속 사용할 수 있습니다.');
            context.login = connection.login;
            context.serverUrl = connection.serverUrl;
        }
        return fn();
    });
};
export const credentials = (target) => {
    const destination = new URL(target), base = new URL(BASE);
    if (destination.origin !== base.origin || !destination.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/api/')) return {};
    const state = requestCtx.getStore();
    const local = agent();
    if (local && local.baseUrl.replace(/\/+$/, '') !== BASE) throw new Error('개인 에이전트 주소가 변경되었습니다. IDE의 FlowLink MCP 연결을 다시 시작하세요.');
    return { ...(auth.token() ? { Authorization: `Bearer ${auth.token()}` } : {}),
        ...(local ? { 'X-FlowLink-Local': local.token } : {}),
        ...(state?.login && destination.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/api/v1/remote/') ? { 'X-FlowLink-Account': state.login, 'X-FlowLink-Server': state.serverUrl } : {}) };
};
export class ApiError extends Error {
    status;
    constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}
export async function api(method, path, body, query) {
    const API = BASE + (desktopAgent && currentTarget() === 'server' ? '/api/v1/remote' : '/api/v1');
    const url = new URL(API + path);
    const workspaceId = currentWorkspace();
    const params = { ...query };
    if (params.workspaceId == null && workspaceId != null) params.workspaceId = workspaceId;
    if (method === 'POST' && workspaceId != null && ['/protocols', '/plugins/scripts', '/mock-servers', '/flows', '/folders'].includes(path))
        body = { ...body, workspaceId: body?.workspaceId ?? workspaceId };
    if (Object.keys(params).length)
        for (const [k, v] of Object.entries(params))
            if (v != null && v !== '')
                url.searchParams.set(k, v);
    const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...credentials(url) },
        redirect: 'error', // 로컬 키·서버 JWT를 다른 목적지로 보내지 않는다.
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j = null;
    try {
        j = text ? JSON.parse(text) : null;
    }
    catch { /* 비JSON 응답 */ }
    if (!r.ok)
        throw new ApiError(r.status, j?.message || j?.error || text || `HTTP ${r.status}`, j);
    return j;
}
export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
