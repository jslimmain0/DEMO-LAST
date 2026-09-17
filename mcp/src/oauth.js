// FlowLink MCP 인가 서버(OAuth 2.1 — MCP Authorization 규약). 클라이언트 설정은 URL 하나, 로그인은 브라우저에서 GitHub(앱 로그인과 같은 디바이스 플로우).
//   흐름: POST /mcp 무토큰 → 401 + WWW-Authenticate(resource_metadata) → 클라이언트가 /.well-known 으로 우리를 인가 서버로 발견 → POST /register(동적 등록)
//         → 브라우저 GET /authorize → "GitHub 로 로그인" → 코드 입력·승인(FlowLink device/start·poll 그대로) → 앱 JWT 를 code 에 묶어 redirect_uri 로
//         → POST /token(PKCE 검증) → access_token = 앱 JWT. 이후 클라이언트가 Authorization: Bearer 로 보내면 REST 에 그대로 전달.
//   refresh 없음(JWT 가 길다 — 기본 30일) — 만료되면 401 → 클라이언트가 다시 브라우저를 띄운다.
//   인가/토큰/등록 핸들러는 SDK 것(redirect_uri·PKCE·rate limit 검증 포함). 우리는 저장소·로그인 페이지·메타데이터만 댄다.
//   issuer 는 요청 Host 로 계산 — 설정값 없음(localhost 로 붙든 LAN IP 로 붙든 그 주소가 곧 인가 서버).
import express from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ApiError, api, withToken } from './client.js';

const issuer = (req) => `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const PAGE = readFileSync(new URL('./login.html', import.meta.url), 'utf8');
const TTL_MS = 15 * 60_000; // 로그인 페이지·code 수명(GitHub 디바이스 코드와 같은 15분)

// ---------- 등록 클라이언트 — 재시작해도 client_id 가 살아야 해서(클라이언트가 캐시해 둔다) 파일에 둔다 ----------
const CLIENTS_FILE = join(homedir(), '.flowlink', 'mcp-clients.json');
const clients = new Map(Object.entries((() => { try { return JSON.parse(readFileSync(CLIENTS_FILE, 'utf8')); } catch { return {}; } })()));
const clientsStore = {
    getClient: (id) => clients.get(id),
    registerClient(c) {
        clients.set(c.client_id, c);
        try { mkdirSync(dirname(CLIENTS_FILE), { recursive: true }); writeFileSync(CLIENTS_FILE, JSON.stringify(Object.fromEntries(clients))); } catch { /* 저장 실패면 재시작 후 재등록 */ }
        return c;
    },
};

// ---------- 진행 중 로그인(tx) · 발급 code — 메모리(단일 프로세스, 분 단위 수명) ----------
const logins = new Map(); // tx → { client, params, session?, at }
const codes = new Map(); // code → { clientId, codeChallenge, redirectUri, token, at }
const sweep = () => { const t = Date.now() - TTL_MS; for (const m of [logins, codes]) for (const [k, v] of m) if (v.at < t) m.delete(k); };
const jwtTtlSec = (jwt) => { try { const exp = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).exp; return Math.max(60, exp - Math.floor(Date.now() / 1000)); } catch { return 3600; } };

const provider = {
    clientsStore,
    /** SDK 가 client·redirect_uri·PKCE 를 검증한 뒤 호출 — 로그인 페이지를 그린다(tx 로 이 인가 요청을 기억). */
    async authorize(client, params, res) {
        sweep();
        const tx = randomUUID();
        logins.set(tx, { client, params, at: Date.now() });
        res.type('html').send(PAGE.replace('__TX__', tx).replace('__CLIENT__', esc(client.client_name || 'MCP 클라이언트')));
    },
    async challengeForAuthorizationCode(client, code) {
        const c = codes.get(code);
        if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('code 가 없거나 만료됐습니다 — 다시 로그인하세요');
        return c.codeChallenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
        const c = codes.get(code);
        codes.delete(code); // 1회성
        if (!c || c.clientId !== client.client_id || (redirectUri && redirectUri !== c.redirectUri)) throw new InvalidGrantError('code 가 없거나 만료됐습니다 — 다시 로그인하세요');
        return { access_token: c.token, token_type: 'bearer', expires_in: jwtTtlSec(c.token) };
    },
    async exchangeRefreshToken() { throw new InvalidGrantError('refresh 미지원 — 다시 로그인하세요'); },
};

export const oauthRouter = express.Router();
// 메타데이터 — 경로형(/mcp)·루트형 둘 다(클라이언트마다 먼저 찾는 쪽이 다르다)
oauthRouter.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) =>
    res.json({ resource: issuer(req) + '/mcp', authorization_servers: [issuer(req)], bearer_methods_supported: ['header'], resource_name: 'FlowLink' }));
oauthRouter.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
    const b = issuer(req);
    res.json({
        issuer: b, authorization_endpoint: b + '/authorize', token_endpoint: b + '/token', registration_endpoint: b + '/register',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });
});
oauthRouter.use('/register', clientRegistrationHandler({ clientsStore }));
oauthRouter.use('/authorize', authorizationHandler({ provider }));
oauthRouter.use('/token', tokenHandler({ provider }));
// 로그인 페이지가 부르는 두 개 — tx 가 열쇠(UUID, 페이지에만 박혀 있다). JWT 는 여기서 안 나가고 code 에만 묶인다.
oauthRouter.post('/login/start', async (req, res) => {
    const l = logins.get(String(req.query.tx ?? ''));
    if (!l) return res.status(400).json({ error: '로그인 세션이 만료됐습니다 — MCP 클라이언트에서 다시 시작하세요.' });
    const d = await api('POST', '/auth/github/device/start', {});
    l.session = d.sessionId;
    res.json({ userCode: d.userCode, verificationUri: d.verificationUri, intervalSec: d.intervalSec });
});
oauthRouter.get('/login/poll', async (req, res) => {
    const tx = String(req.query.tx ?? '');
    const l = logins.get(tx);
    if (!l?.session) return res.json({ status: 'error', error: '로그인 세션이 만료됐습니다 — MCP 클라이언트에서 다시 시작하세요.' });
    const p = await api('GET', '/auth/github/device/poll', undefined, { session: l.session });
    if (p.status !== 'ready') return res.json(p.status === 'error' ? { status: 'error', error: p.error || '로그인 실패' } : { status: 'pending' });
    const code = randomBytes(32).toString('base64url');
    codes.set(code, { clientId: l.client.client_id, codeChallenge: l.params.codeChallenge, redirectUri: l.params.redirectUri, token: p.token, at: Date.now() });
    logins.delete(tx);
    const u = new URL(l.params.redirectUri);
    u.searchParams.set('code', code);
    if (l.params.state) u.searchParams.set('state', l.params.state);
    res.json({ status: 'ready', login: p.login, redirect: u.href });
});
// 라우터 안의 에러(FlowLink 다운 등)는 JSON 으로 — 페이지 스크립트가 error 를 읽어 보여준다
// eslint-disable-next-line no-unused-vars
oauthRouter.use((err, req, res, _next) => res.status(err instanceof ApiError ? 502 : 500).json({ error: err?.message || String(err) }));

/** 주어진 토큰(null=익명)으로 /auth/me 가 통하는지 — 401/403 이면 거부, 그 외 오류는 던진다(FlowLink 다운을 401 로 위장하지 않는다). */
const accepted = (token) => withToken(token, () => api('GET', '/auth/me')).then(() => true, (e) => { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return false; throw e; });
/**
 * FlowLink 가 익명을 받는지 — dev 모드, 또는 github+게스트 스위치(FLOWLINK_AUTH_GUEST_ENABLED: 에이전트가 로그인 없이 수정하라고 켜 두는 것)면 true.
 * 한 번 읽고 기억(FlowLink 오류면 다음 요청에 다시).
 */
let anonP = null;
const anonymousOk = () => (anonP ??= accepted(null).catch((e) => { anonP = null; throw e; }));

/**
 * /mcp 문지기 — Bearer 가 있으면 유효해야 하고(무효/만료는 REST 가 어차피 401 → 재로그인), 없으면 FlowLink 가 익명을 받을 때만 통과.
 * 막히면 401 + WWW-Authenticate 로 응답해 클라이언트가 OAuth 로그인을 시작하게 한다. 반환 { ok, token } — ok=false 면 이미 응답했다.
 */
export async function gate(req, res) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const token = m ? m[1].trim() : null;
    if (token ? await accepted(token) : await anonymousOk()) return { ok: true, token };
    res.status(401)
        .set('WWW-Authenticate', `Bearer realm="flowlink", error="invalid_token", resource_metadata="${issuer(req)}/.well-known/oauth-protected-resource/mcp"`)
        .json({ error: 'unauthorized', message: '로그인이 필요합니다 — MCP 클라이언트가 브라우저를 열어 GitHub 로 로그인합니다.' });
    return { ok: false, token };
}
