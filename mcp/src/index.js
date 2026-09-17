#!/usr/bin/env node
// FlowLink MCP 서버 — 에이전트가 프로토콜·Mock·워크플로를 만들고, 실행하고, 로그를 관찰한다.
//   FLOWLINK_URL=http://localhost:18080 FLOWLINK_MCP_PORT=18090 node mcp/src/index.js
//   FlowLink 서버 옆에 떠서 Streamable HTTP(세션 없음)로 http://<host>:18090/mcp 를 연다 — 클라이언트 설정은 URL 한 줄, 웹 에이전트도 붙는다.
//   요청마다 새 McpServer/transport(SDK 의 stateless 관례). 로그인은 OAuth(oauth.js): github 모드면 무토큰 요청에 401 을 줘 클라이언트가
//   브라우저를 열고, 받은 앱 JWT 를 Authorization: Bearer 로 보내면 요청 컨텍스트에 실어 REST 로 그대로 전달한다. dev 모드는 로그인 없음.
//   순수 JS(빌드 없음) — 설치된 패키지는 node_modules 아래라 Node 가 .ts 타입 스트리핑을 거부하므로 소스가 JS 다.
// 툴은 REST 1:1 이 아니라 작업 단위이고, 응답은 에이전트 컨텍스트를 아끼려 짧은 텍스트 요약이다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express from 'express';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { ApiError, BASE, api, auth, sleep, withToken } from './client.js';
import { gate, oauthRouter } from './oauth.js';
const VERSION = createRequire(import.meta.url)('../package.json').version;
/** 툴 레지스트리 — 요청마다 새 McpServer 를 만들어야 해서(stateless) 등록을 함수로 미룬다. */
const TOOLS = [];
const tool = (name, cfg, handler) => TOOLS.push({ name, cfg, handler });
function buildServer() {
    const server = new McpServer({ name: 'flowlink', version: VERSION });
    for (const t of TOOLS)
        server.registerTool(t.name, t.cfg, t.handler);
    return server;
}
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (e) => {
    let hint = '';
    // 문지기(gate)가 무효 토큰·(로그인 필수 서버의) 무토큰을 401 로 미리 걸러낸다. 여기 401 은 게스트가 로그인 필수 경로(AI 등)를 친 것 아니면 호출 도중 만료.
    const LOGIN = ' MCP 클라이언트에서 flowlink 서버를 인증(로그인)하세요 — 브라우저가 열려 GitHub 로 로그인합니다.';
    if (e instanceof ApiError && e.status === 401)
        hint = auth.token() ? '\n→ 로그인 토큰이 만료됐거나 무효합니다.' + LOGIN : '\n→ 로그인이 필요합니다.' + LOGIN;
    else if (e instanceof ApiError && e.status === 403)
        hint = auth.token() ? '\n→ 권한이 없습니다(승인 대기 중일 수 있음 — 관리자 승인 필요). flowlink_status 로 상태 확인.'
            : '\n→ 게스트는 여기까지(프로토콜/환경 저장 등은 승인 사용자 필요).' + LOGIN;
    return { content: [{ type: 'text', text: `⚠ ${e instanceof ApiError ? `HTTP ${e.status}: ` : ''}${e instanceof Error ? e.message : String(e)}${hint}` }], isError: true };
};
const run = async (fn) => { try {
    return ok(await fn());
}
catch (e) {
    return fail(e);
} };
const clip = (s, n) => { const t = typeof s === 'string' ? s : JSON.stringify(s ?? null); return t.length > n ? t.slice(0, n) + `…(+${t.length - n})` : t; };
const json = (v) => JSON.stringify(v, null, 1);
const jsonArg = z.union([z.record(z.string(), z.unknown()), z.string().transform((s, ctx) => { try {
        return JSON.parse(s);
    }
    catch (e) {
        ctx.addIssue({ code: 'custom', message: 'JSON 파싱 실패: ' + e.message });
        return z.NEVER;
    } })]);
// ---------- 상태 · 로그인 ----------
tool('flowlink_status', {
    title: 'FlowLink 상태',
    description: '연결된 FlowLink 주소·인증 모드·로그인 상태·승인 여부. 다른 툴이 403 이면 먼저 이걸로 확인.',
    inputSchema: {},
}, async () => run(async () => {
    const lines = [`url: ${BASE}`, 'transport: http(서빙 — 요청은 FlowLink 서버에서 나간다)'];
    const cfg = await api('GET', '/auth/config');
    const mode = cfg.mode ?? (cfg.enabled ? 'github' : 'none');
    lines.push(`auth mode: ${mode}`);
    if (mode !== 'github') {
        lines.push('login: 불필요(dev 모드 — 전권)');
        return lines.join('\n');
    }
    // github 모드 — 무토큰으로 여기 왔다면 게스트 스위치가 켜진 서버(익명 허용). 토큰이 있으면 문지기가 이미 검증했다.
    if (!auth.token()) {
        lines.push('login: 없음 · 게스트(게스트 스위치 ON) — 읽기·워크플로·Mock 은 그대로, 프로토콜/환경 저장·AI 는 승인 사용자 필요. 내 이름으로 하려면 MCP 클라이언트에서 flowlink 서버를 인증(로그인).');
        return lines.join('\n');
    }
    const me = await api('GET', '/admin/me');
    lines.push(`login: ${me.username ?? '?'}`, `status: ${me.myStatus ?? '?'}${me.admin ? ' · ADMIN' : ''}${me.pendingCount ? ` · 승인 대기 ${me.pendingCount}명` : ''}`);
    return lines.join('\n');
}));
// ---------- 가이드(스키마 원문) ----------
tool('flowlink_guide', {
    title: '규격 가이드',
    description: '워크플로 그래프(flow=노드 타입 전체 레퍼런스, 각 노드 JSON 예시 포함)·프로토콜(protocol)·HTTP Mock(mock) JSON 규격과 에이전트 규약(rules) 원문. nodes=flow 별칭(노드 설명). 무언가 만들기 전에 해당 topic 을 한 번 읽는다. TRANSFORM 노드/코덱을 쓰려면 먼저 plugin_list.',
    inputSchema: { topic: z.enum(['flow', 'nodes', 'protocol', 'mock', 'rules', 'all']) },
}, async ({ topic }) => run(async () => {
    const s = await api('GET', '/schemas');
    if (topic === 'all')
        return Object.entries(s).map(([k, v]) => `# ${k}\n${v}`).join('\n\n');
    if (topic === 'nodes')
        return s.flow ?? '(flow 없음)';
    return s[topic] ?? `(${topic} 없음)`;
}));
// ---------- 워크스페이스 · 폴더 (이름으로 지목 — "어느 워크스페이스의 어느 폴더에서") ----------
/** 워크스페이스 참조(이름·id·'public'·생략=공용) → { id, name, q }. q 는 REST 에 넣는 값(공용=null). 없으면 볼 수 있는 목록을 보여주며 실패. */
async function wsOf(ref) {
    const r = (ref ?? '').trim();
    if (!r || r === 'public' || r === '공용')
        return { id: 'public', name: '공용', q: null };
    const list = await api('GET', '/workspaces');
    const hit = list.find((w) => w.id === r) ?? list.find((w) => w.name.toLowerCase() === r.toLowerCase());
    if (!hit)
        throw new Error(`워크스페이스 없음: ${r} — 내가 볼 수 있는 것: ${list.map((w) => w.name).join(', ')}`);
    return { id: hit.id, name: hit.name, q: hit.id };
}
/** 워크스페이스의 폴더 목록 + 경로("상위/하위"). */
async function folderList(w) {
    const list = await api('GET', '/folders', undefined, { workspaceId: w.q });
    const byId = new Map(list.map((f) => [f.id, f]));
    const path = (f) => (f.parentId && byId.has(f.parentId) ? path(byId.get(f.parentId)) + '/' : '') + f.name;
    return list.map((f) => ({ ...f, path: path(f) }));
}
/** 폴더 참조(id·이름·"상위/하위" 경로·생략 또는 "/"=루트) → 폴더 | null(루트). 같은 이름이 여럿이면 경로로 지목하라고 실패. */
async function folderOf(w, ref, fs) {
    const r = (ref ?? '').trim();
    if (!r || r === '/')
        return null;
    fs ??= await folderList(w);
    let hits = fs.filter((f) => f.id === r || f.path === r);
    if (!hits.length)
        hits = fs.filter((f) => f.name === r);
    if (hits.length === 1)
        return hits[0];
    if (hits.length > 1)
        throw new Error(`폴더 이름이 겹칩니다: ${hits.map((f) => f.path).join(' · ')} — 경로("상위/하위")로 지목하세요`);
    throw new Error(`폴더 없음: ${r} (${w.name}) — 있는 폴더: ${fs.map((f) => f.path).join(', ') || '(없음)'}`);
}
const WS_ARG = z.string().optional().describe('워크스페이스 이름 또는 id(workspace_list). 생략=공용');
const FOLDER_ARG = z.string().optional().describe('폴더 이름 또는 "상위/하위" 경로(folder_list). 생략 또는 "/"=루트');
tool('workspace_list', {
    title: '워크스페이스 목록',
    description: '내가 볼 수 있는 워크스페이스(공용·개인·팀)와 내 롤. 다른 툴의 workspace 인자엔 여기 이름(또는 id)을 쓴다. 생략=공용.',
    inputSchema: {},
}, async () => run(async () => (await api('GET', '/workspaces')).map((w) => `${w.name} [${w.id}] ${w.kind} · 내 롤 ${w.myRole}`).join('\n')));
tool('workspace_get', {
    title: '워크스페이스 한눈에',
    description: '워크스페이스 하나의 폴더 트리 + 각 폴더의 워크플로 + Mock 목록. "어느 워크스페이스의 어느 폴더에서" 작업하기 전에 구조를 본다.',
    inputSchema: { workspace: WS_ARG },
}, async ({ workspace }) => run(async () => {
    const w = await wsOf(workspace);
    const [fs, flows, mocks] = await Promise.all([folderList(w), api('GET', '/flows', undefined, { workspaceId: w.q }), api('GET', '/mock-servers', undefined, { workspaceId: w.q })]);
    const byFolder = new Map();
    for (const f of flows)
        byFolder.set(f.folderId ?? '', [...(byFolder.get(f.folderId ?? '') ?? []), f]);
    const flowLine = (f) => `  - ${f.name} [${f.id}] v${f.currentVersion} 노드 ${f.nodeCount}`;
    const lines = [`워크스페이스 ${w.name} [${w.id}] · 폴더 ${fs.length} · 워크플로 ${flows.length} · Mock ${mocks.length}`, '📁 (루트)', ...(byFolder.get('') ?? []).map(flowLine)];
    for (const d of [...fs].sort((a, b) => a.path.localeCompare(b.path)))
        lines.push(`📁 ${d.path} [${d.id}]`, ...(byFolder.get(d.id) ?? []).map(flowLine));
    lines.push(`Mock: ${mocks.map((m) => `${m.name} [${m.slug}] ${m.kind}${m.enabled ? '' : '(off)'}`).join(' · ') || '(없음)'}`);
    return lines.join('\n');
}));
tool('workspace_export', {
    title: '워크스페이스 내보내기',
    description: '워크스페이스 통째(폴더+워크플로 그래프+Mock spec)를 JSON 번들로. workspace_import 로 다른 워크스페이스/서버에 복사.',
    inputSchema: { workspace: WS_ARG },
}, async ({ workspace }) => run(async () => clip(json(await api('GET', `/workspaces/${(await wsOf(workspace)).id}/export`)), 120000)));
tool('workspace_import', {
    title: '워크스페이스 가져오기',
    description: 'workspace_export 번들을 이 워크스페이스로 가져온다(전부 새 id, slug 충돌은 자동 개명, TCP Mock 은 꺼서).',
    inputSchema: { workspace: WS_ARG, bundle: jsonArg },
}, async ({ workspace, bundle }) => run(async () => {
    const r = await api('POST', `/workspaces/${(await wsOf(workspace)).id}/import`, bundle);
    return `가져옴: 폴더 ${r.folders} · 워크플로 ${r.flows} · Mock ${r.mocks}${r.warnings?.length ? '\n⚠ ' + r.warnings.join('\n⚠ ') : ''}`;
}));
tool('folder_list', { title: '폴더 목록', description: '워크스페이스의 폴더(경로·id·워크플로 수).', inputSchema: { workspace: WS_ARG } }, async ({ workspace }) => run(async () => {
    const fs = await folderList(await wsOf(workspace));
    return fs.length ? fs.sort((a, b) => a.path.localeCompare(b.path)).map((f) => `${f.path} [${f.id}] 워크플로 ${f.flowCount}`).join('\n') : '(폴더 없음 — 루트만)';
}));
tool('folder_create', { title: '폴더 생성', description: '워크스페이스에 폴더를 만든다(parent 로 하위 폴더).', inputSchema: { workspace: WS_ARG, name: z.string().min(1), parent: FOLDER_ARG } }, async ({ workspace, name, parent }) => run(async () => {
    const w = await wsOf(workspace);
    const p = await folderOf(w, parent);
    const f = await api('POST', '/folders', { name, parentId: p?.id ?? null, workspaceId: w.q });
    return `생성: ${p ? p.path + '/' : ''}${f.name} [${f.id}]`;
}));
tool('folder_update', { title: '폴더 이름 변경/이동', description: 'name 으로 이름 변경, parent 로 다른 폴더 밑으로 이동("/"=루트).', inputSchema: { workspace: WS_ARG, folder: z.string(), name: z.string().optional(), parent: FOLDER_ARG } }, async ({ workspace, folder, name, parent }) => run(async () => {
    const w = await wsOf(workspace);
    const f = await folderOf(w, folder);
    if (!f) throw new Error('루트는 바꿀 수 없습니다');
    if (name) await api('PATCH', `/folders/${f.id}`, { name });
    if (parent != null) await api('PUT', `/folders/${f.id}/parent`, { parentId: (await folderOf(w, parent))?.id ?? null });
    const n = (await folderList(w)).find((x) => x.id === f.id);
    return `변경: ${n?.path ?? f.name} [${f.id}]`;
}));
tool('folder_delete', { title: '폴더 삭제', description: '폴더 삭제(안의 워크플로는 서버 규칙대로 — 비어 있지 않으면 실패할 수 있음).', inputSchema: { workspace: WS_ARG, folder: z.string() } }, async ({ workspace, folder }) => run(async () => {
    const f = await folderOf(await wsOf(workspace), folder);
    if (!f) throw new Error('루트는 삭제할 수 없습니다');
    await api('DELETE', `/folders/${f.id}`);
    return `삭제됨: ${f.path}`;
}));
// ---------- 프로토콜 ----------
async function findProtocol(ref) {
    const list = await api('GET', '/protocols');
    return list.find((p) => (ref.id && p.id === ref.id) || (ref.name && p.name === ref.name)) ?? null;
}
const tableLen = (fields) => (fields ?? []).reduce((a, f) => a + (Number(f.len) || 0), 0);
function protocolSummary(d) {
    const s = d.spec ?? {};
    const hl = tableLen(s.header);
    const msgs = (s.messages ?? []).map((m) => `${m.key}${m.label ? `(${m.label})` : ''} ${hl + tableLen(m.fields)}B`).join(' · ');
    return `${d.name} [${d.id}] ${s.encoding ?? ''} 헤더 ${hl}B · 길이필드 ${s.lengthField ?? '?'}(${s.lengthFormat ?? 'ascii-decimal'}, includesSelf=${!!s.includesSelf}) · 분기 ${s.discriminator || '(없음)'}\n전문: ${msgs || '(없음)'}`;
}
tool('protocol_list', { title: '프로토콜 목록', description: '저장된 고정길이 전문 프로토콜 목록(id·이름·인코딩·전문 수).', inputSchema: {} }, async () => run(async () => { const l = await api('GET', '/protocols'); return l.length ? l.map((p) => `${p.name} [${p.id}] ${p.encoding} · 전문 ${p.messageCount}`).join('\n') : '(프로토콜 없음)'; }));
tool('protocol_get', { title: '프로토콜 조회', description: 'id 또는 name 으로 프로토콜 spec JSON 을 가져온다.', inputSchema: { id: z.string().optional(), name: z.string().optional() } }, async (ref) => run(async () => { const p = await findProtocol(ref); if (!p)
    throw new Error('프로토콜 없음'); const d = await api('GET', `/protocols/${p.id}`); return protocolSummary(d) + '\n' + json(d.spec); }));
tool('protocol_upsert', {
    title: '프로토콜 생성/갱신',
    description: '이름이 있으면 갱신, 없으면 생성. spec 은 flowlink_guide(protocol) 규격(JSON 객체 또는 JSON 문자열). 검증 실패는 서버 메시지로 돌려준다.',
    inputSchema: { name: z.string().min(1), spec: jsonArg },
}, async ({ name, spec }) => run(async () => {
    const existing = await findProtocol({ name });
    const d = existing ? await api('PUT', `/protocols/${existing.id}`, { spec }) : await api('POST', '/protocols', { name, spec });
    return `${existing ? '갱신' : '생성'}: ` + protocolSummary(d);
}));
tool('protocol_preview', {
    title: '전문 조립 미리보기',
    description: '프로토콜(id/name 또는 spec)과 전문 key·값으로 실제 바이트를 조립해 hex/텍스트/필드 오프셋을 보여준다(전송 없음). 값 검증 오류도 여기서 잡힌다.',
    inputSchema: { protocolId: z.string().optional(), name: z.string().optional(), spec: jsonArg.optional(), key: z.string(), values: z.record(z.string(), z.string()).optional() },
}, async ({ protocolId, name, spec, key, values }) => run(async () => {
    let s = spec;
    if (!s) {
        const p = await findProtocol({ id: protocolId, name });
        if (!p)
            throw new Error('프로토콜 없음');
        s = (await api('GET', `/protocols/${p.id}`)).spec;
    }
    const r = await api('POST', '/protocols/preview', { spec: s, key, values: values ?? {} });
    if (r.errors?.length)
        return '⚠ ' + r.errors.map((e) => `${e.field ? e.field + ': ' : ''}${e.message}`).join(' · ');
    const rows = (r.fields ?? []).map((f) => `@${f.offset} ${f.name}=${JSON.stringify(f.value)} ${f.actualBytes}/${f.len}B${f.warn ? ' ' + f.warn : ''}`).join('\n');
    return `총 ${r.total}B\n${rows}\n텍스트: ${r.text}\nhex: ${r.hex}${r.warnings?.length ? '\n⚠ ' + r.warnings.join(' · ') : ''}`;
}));
tool('protocol_delete', { title: '프로토콜 삭제', description: 'id 로 삭제(참조하는 노드/Mock 은 실행 시 실패).', inputSchema: { id: z.string() } }, async ({ id }) => run(async () => { await api('DELETE', `/protocols/${id}`); return '삭제됨'; }));
// ---------- Mock ----------
async function fleet() { return api('GET', '/mock-servers/fleet'); }
async function findMock(slug) { const f = await fleet(); return f.servers.find((s) => s.slug === slug) ?? null; }
function mockLine(s, f) {
    const where = s.kind === 'TCP' ? `:${s.tcpPort ?? '?'} ${s.listening ? 'LISTENING' : s.listenError ? 'FAILED(' + s.listenError + ')' : 'OFF'}` : `${BASE}${f.contextPath ?? ''}/mock/${s.slug}`;
    const cfg = s.kind === 'TCP' ? `프로토콜 ${s.protocolName ?? '없음'} · 규칙 ${s.tcpRuleCount ?? 0}${s.upstream ? ` · proxy→${s.upstream}` : ''}` : `라우트 ${s.routeCount ?? 0}${(s.routeLabels ?? []).length ? ' (' + s.routeLabels.slice(0, 4).join(', ') + ')' : ''}`;
    return `${s.name} [${s.slug}] ${s.kind} ${s.enabled ? 'on' : 'off'} ${where} · ${cfg}${s.lastRequestAt ? ` · 최근요청 ${s.lastRequestAt}` : ''}${s.unmatchedRequests ? ` · 무매칭 ${s.unmatchedRequests}` : ''}`;
}
tool('mock_list', { title: 'Mock 목록', description: 'Mock 서버(종류·켜짐·주소/포트·리스너 상태·프로토콜·최근 요청). workspace 생략=전체.', inputSchema: { workspace: WS_ARG } }, async ({ workspace }) => run(async () => {
    const f = await fleet();
    const w = workspace ? await wsOf(workspace) : null;
    const rows = w ? f.servers.filter((s) => (s.workspaceId ?? 'public') === w.id) : f.servers; // fleet 은 'public' 문자열
    return rows.length ? rows.map((s) => mockLine(s, f)).join('\n') : '(Mock 없음)';
}));
tool('mock_get', { title: 'Mock 조회', description: 'slug 로 Mock spec JSON 을 가져온다.', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => { const m = await findMock(slug); if (!m)
    throw new Error('Mock 없음: ' + slug); const d = await api('GET', `/mock-servers/${m.id}`); return `${d.name} [${d.slug}] ${d.kind} v${d.currentVersion ?? 0}\n` + json(d.spec); }));
tool('mock_upsert', {
    title: 'Mock 생성/갱신',
    description: 'slug 가 있으면 spec 갱신, 없으면 생성 후 spec 저장. HTTP spec 은 flowlink_guide(mock) 규격, TCP spec 은 {"tcp":{"port","protocolId","upstream","timeoutMs","rules":[{"id","when":[{"field","op","value"}],"then":{"mode":"mock|proxy","fields":{...}},"fault":{...}}]}}. 저장 즉시 서빙/리스너 반영.',
    inputSchema: { name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'slug 는 소문자·숫자·하이픈 3~40자'), type: z.enum(['HTTP', 'TCP']), spec: jsonArg, enabled: z.boolean().optional(), workspace: WS_ARG.describe('생성 시 소속 워크스페이스(이름/id). 생략=공용') },
}, async ({ name, slug, type, spec, enabled, workspace }) => run(async () => {
    let m = await findMock(slug);
    let created = false;
    if (!m) {
        const d = await api('POST', '/mock-servers', { name, slug, type, workspaceId: (await wsOf(workspace)).q });
        m = { id: d.id };
        created = true;
    }
    await api('PUT', `/mock-servers/${m.id}/spec`, { spec, note: 'mcp' });
    if (!created && (name || enabled !== undefined))
        await api('PATCH', `/mock-servers/${m.id}`, { name, enabled });
    else if (created && enabled === false)
        await api('PATCH', `/mock-servers/${m.id}`, { enabled: false });
    const f = await fleet();
    const s = f.servers.find((x) => x.id === m.id);
    return `${created ? '생성' : '갱신'}: ` + (s ? mockLine(s, f) : slug);
}));
tool('mock_send', {
    title: 'TCP Mock 에 전문 보내기',
    description: 'TCP Mock 리스너로 전문을 실제 소켓으로 보내고 프로토콜로 디코딩한 응답을 돌려준다(key=요청 전문 키, values=필드 값).',
    inputSchema: { slug: z.string(), key: z.string(), values: z.record(z.string(), z.string()).optional() },
}, async ({ slug, key, values }) => run(async () => {
    const m = await findMock(slug);
    if (!m)
        throw new Error('Mock 없음: ' + slug);
    const r = await api('POST', `/mock-servers/${m.id}/tcp-send`, { key, values: values ?? {} });
    const resp = r.response;
    const kv = (o) => o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' · ') : '(없음)';
    return [`요청 ${r.request.total}B → 응답 ${resp.bytes}B ${r.elapsedMs}ms · 전문 ${resp.key ?? `미정의(${resp.disc ?? '?'})`}${resp.partial ? ' · 부분 수신' : ''}`,
        `헤더: ${kv(resp.header)}`, `본문: ${resp.body ? kv(resp.body) : '(표 없음 — raw) ' + clip(resp.text, 300)}`,
        ...(resp.warnings?.length ? ['⚠ ' + resp.warnings.join(' · ')] : []), `텍스트: ${clip(resp.text, 400)}`].join('\n');
}));
tool('mock_log', {
    title: 'Mock 트래픽 로그',
    description: 'TCP Mock 은 전문 로그(→/← · [mock]/[proxy]/[none] · 필드 · 부분 수신 · 경고), HTTP Mock 은 요청 기록. 최신순 limit 개.',
    inputSchema: { slug: z.string(), limit: z.number().int().min(1).max(200).optional(), hex: z.boolean().optional() },
}, async ({ slug, limit, hex }) => run(async () => {
    const m = await findMock(slug);
    if (!m)
        throw new Error('Mock 없음: ' + slug);
    const n = limit ?? 20;
    if (m.kind === 'TCP') {
        const rows = await api('GET', `/mock-servers/${m.id}/tcp-log`);
        if (!rows.length)
            return '(로그 없음)';
        return rows.slice(0, n).map((e) => {
            const fields = Object.entries(e.fields ?? {}).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ');
            return `${e.at} ${e.dir === 'in' ? '→' : '←'} [${e.source}] ${e.key ?? '-'} ${fields} ${e.bytes}B${e.partial ? ` 부분수신(${(e.chunks ?? []).join('+')})` : ''}${e.level !== 'info' ? ` ${e.level.toUpperCase()}` : ''}${e.note ? ` · ${e.note}` : ''}${hex && e.hex ? `\n   hex ${e.hex}` : ''}`;
        }).join('\n');
    }
    const rows = await api('GET', `/mock-servers/${m.id}/requests`);
    if (!rows.length)
        return '(요청 기록 없음)';
    return rows.slice(0, n).map((e) => `${e.at} ${e.method} ${e.path}${Object.keys(e.query ?? {}).length ? '?' + new URLSearchParams(e.query).toString() : ''} → ${e.status}${e.matchedRuleId ? ` rule=${e.matchedRuleId}` : ' 무매칭'}${e.bodyText ? ` body=${clip(e.bodyText, 160)}` : ''}`).join('\n');
}));
tool('mock_delete', { title: 'Mock 삭제', description: 'slug 로 Mock 삭제(리스너 닫힘).', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => { const m = await findMock(slug); if (!m)
    throw new Error('Mock 없음: ' + slug); await api('DELETE', `/mock-servers/${m.id}`); return '삭제됨: ' + slug; }));
const mockOrFail = async (slug) => { const m = await findMock(slug); if (!m) throw new Error('Mock 없음: ' + slug); return m; };
const versionLine = (v) => `v${v.versionNo}${v.pinned ? ' 📌' : ''} ${v.createdAt}${v.createdBy ? ` ${v.createdBy}` : ''}${v.note ? ` · ${v.note}` : ''}`;
tool('mock_versions', { title: 'Mock 버전 목록', description: 'spec 저장 이력(버전 번호·시각·메모·고정).', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => (await api('GET', `/mock-servers/${(await mockOrFail(slug)).id}/versions`)).map(versionLine).join('\n') || '(버전 없음)'));
tool('mock_version', {
    title: 'Mock 특정 버전',
    description: '기본은 그 버전 spec JSON 조회. restore=true 면 그 버전을 새 현재 버전으로 복원(즉시 반영), pinned 를 주면 고정/해제.',
    inputSchema: { slug: z.string(), versionNo: z.number().int(), restore: z.boolean().optional(), pinned: z.boolean().optional() },
}, async ({ slug, versionNo, restore, pinned }) => run(async () => {
    const m = await mockOrFail(slug);
    if (pinned != null) { await api('PUT', `/mock-servers/${m.id}/versions/${versionNo}/pin`, { pinned }); return `v${versionNo} ${pinned ? '고정' : '고정 해제'}`; }
    if (restore) { const v = await api('POST', `/mock-servers/${m.id}/versions/${versionNo}/restore`); return `복원: v${versionNo} → 새 버전 v${v.versionNo}`; }
    return `v${versionNo}\n` + json(await api('GET', `/mock-servers/${m.id}/versions/${versionNo}`));
}));
tool('mock_state', { title: 'Mock 런타임 상태', description: '상태 변수(state)·규칙별 히트 수·seq·요청 수 — 시나리오형 Mock 디버깅.', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => {
    const s = await api('GET', `/mock-servers/${(await mockOrFail(slug)).id}/state`);
    const kv = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '(없음)';
    return `요청 ${s.requestCount} · seq ${s.seq}\n상태: ${kv(s.state)}\n히트: ${kv(s.hits)}`;
}));
tool('mock_reset', { title: 'Mock 상태 초기화', description: '상태 변수·히트 카운터·seq 를 초기화(spec 은 그대로).', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => { await api('POST', `/mock-servers/${(await mockOrFail(slug)).id}/reset`); return '초기화됨: ' + slug; }));
tool('mock_clear_log', { title: 'Mock 로그 비우기', description: '요청 기록(HTTP)·전문 로그(TCP)를 비운다 — 테스트 전 깨끗한 상태로.', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => {
    const m = await mockOrFail(slug);
    await api('DELETE', `/mock-servers/${m.id}/${m.kind === 'TCP' ? 'tcp-log' : 'requests'}`);
    return '로그 비움: ' + slug;
}));
tool('mock_usages', { title: 'Mock 을 쓰는 워크플로', description: '각 Mock 을 어느 워크플로가 참조하는지(삭제/변경 전 영향 확인). workspace 생략=공용.', inputSchema: { workspace: WS_ARG } }, async ({ workspace }) => run(async () => {
    const w = await wsOf(workspace);
    const [u, f] = await Promise.all([api('GET', '/mock-servers/usages', undefined, { workspaceId: w.q }), fleet()]);
    const rows = Object.entries(u).map(([id, flows]) => { const s = f.servers.find((x) => x.id === id); return `${s ? `${s.name} [${s.slug}]` : id} ← ${flows.map((x) => `${x.name} [${x.id}]`).join(', ')}`; });
    return rows.join('\n') || '(참조하는 워크플로 없음)';
}));
tool('codec_try', {
    title: '코덱 시험',
    description: 'Mock 코덱(변환 단계 목록)을 샘플 전문에 적용해 단계별 입출력을 본다(저장 안 함). codec={"request":[step…],"response":[step…]} — flowlink_guide(mock) 규격, side=request|response.',
    inputSchema: { slug: z.string(), codec: jsonArg, side: z.enum(['request', 'response']).optional(), message: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), contentType: z.string().optional(), environment: z.string().optional() },
}, async ({ slug, codec, side, message, headers, contentType, environment }) => run(async () => {
    const r = await api('POST', `/mock-servers/${(await mockOrFail(slug)).id}/codec-try`, { codec, side, message, headers, contentType, environment });
    const steps = (r.steps ?? []).map((s) => `${s.index}. ${s.id} (${s.target}${s.field ? ':' + s.field : ''}) ${clip(s.input, 120)} → ${clip(s.output, 200)}`).join('\n');
    return `결과: ${clip(r.result, 1500)}\n필드: ${Object.entries(r.fields ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '(없음)'}\n${steps || '(단계 없음)'}`;
}));
// ---------- 워크플로 · 실행 ----------
tool('flow_list', { title: '워크플로 목록', description: '워크플로 목록(폴더 경로/이름·id·노드 수·수정 시각). workspace 생략=공용, folder 로 그 폴더만.', inputSchema: { workspace: WS_ARG, folder: FOLDER_ARG } }, async ({ workspace, folder }) => run(async () => {
    const w = await wsOf(workspace);
    const [fs, l] = await Promise.all([folderList(w), api('GET', '/flows', undefined, { workspaceId: w.q })]);
    const want = folder ? await folderOf(w, folder, fs) : null;
    const path = new Map(fs.map((f) => [f.id, f.path]));
    const rows = l.filter((f) => !want || f.folderId === want.id);
    return rows.length ? rows.map((f) => `${f.folderId ? (path.get(f.folderId) ?? '?') + '/' : ''}${f.name} [${f.id}] v${f.currentVersion} 노드 ${f.nodeCount} · ${f.updatedAt}`).join('\n') : '(워크플로 없음)';
}));
tool('flow_get', { title: '워크플로 조회', description: 'id 로 현재 그래프 JSON(nodes/edges)을 가져온다.', inputSchema: { id: z.string() } }, async ({ id }) => run(async () => { const d = await api('GET', `/flows/${id}`); return `${d.name} [${d.id}] v${d.currentVersion}\n` + json(d.graph); }));
tool('flow_upsert', {
    title: '워크플로 저장',
    description: 'graph(flowlink_guide(flow) 규격: nodes/edges, START·END 필수)를 새 버전으로 저장. id 없으면 name 으로 새 워크플로 생성 — workspace·folder 로 어디에 만들지 지목(기존 워크플로 이동은 flow_update). 검증 실패는 서버 메시지.',
    inputSchema: { id: z.string().optional(), name: z.string().optional(), graph: jsonArg, note: z.string().optional(), workspace: WS_ARG, folder: FOLDER_ARG },
}, async ({ id, name, graph, note, workspace, folder }) => run(async () => {
    let flowId = id;
    if (!flowId) {
        if (!name)
            throw new Error('name 또는 id 가 필요합니다');
        const w = await wsOf(workspace);
        const f = await folderOf(w, folder);
        const c = await api('POST', '/flows', { name, description: null, folderId: f?.id ?? null, workspaceId: w.q });
        flowId = c.id;
    }
    const v = await api('POST', `/flows/${flowId}/versions`, { graph, note: note ?? 'mcp', pinned: false });
    const nodes = graph.nodes?.length ?? 0;
    return `저장: flow ${flowId} v${v.versionNo ?? v.currentVersion ?? '?'} · 노드 ${nodes} · 편집기 ${BASE}/flows/${flowId}`;
}));
tool('flow_update', {
    title: '워크플로 이름/설명/폴더 변경',
    description: 'name·description 변경, folder 로 같은 워크스페이스의 다른 폴더로 이동("/"=루트).',
    inputSchema: { id: z.string(), name: z.string().optional(), description: z.string().optional(), folder: FOLDER_ARG },
}, async ({ id, name, description, folder }) => run(async () => {
    const d = await api('GET', `/flows/${id}`);
    if (name != null || description != null)
        await api('PATCH', `/flows/${id}`, { name, description });
    if (folder != null) {
        const w = { id: d.workspaceId ?? 'public', name: d.workspaceId ?? '공용', q: d.workspaceId ?? null };
        await api('PUT', `/flows/${id}/folder`, { folderId: (await folderOf(w, folder))?.id ?? null });
    }
    const n = await api('GET', `/flows/${id}`);
    return `변경: ${n.name} [${n.id}]${n.description ? ` — ${n.description}` : ''} · 폴더 ${n.folderId ?? '(루트)'}`;
}));
tool('flow_delete', { title: '워크플로 삭제', description: 'id 로 워크플로 삭제.', inputSchema: { id: z.string() } }, async ({ id }) => run(async () => { await api('DELETE', `/flows/${id}`); return '삭제됨: ' + id; }));
tool('flow_versions', { title: '워크플로 버전 목록', description: '저장 이력(버전 번호·시각·작성자·메모·고정).', inputSchema: { id: z.string() } }, async ({ id }) => run(async () => (await api('GET', `/flows/${id}/versions`)).map(versionLine).join('\n') || '(버전 없음)'));
tool('flow_version', {
    title: '워크플로 특정 버전',
    description: '기본은 그 버전 그래프 JSON 조회(diff 용). restore=true 면 그 버전을 새 현재 버전으로 복원, pinned 를 주면 고정/해제.',
    inputSchema: { id: z.string(), versionNo: z.number().int(), restore: z.boolean().optional(), pinned: z.boolean().optional() },
}, async ({ id, versionNo, restore, pinned }) => run(async () => {
    if (pinned != null) { await api('PUT', `/flows/${id}/versions/${versionNo}/pin`, { pinned }); return `v${versionNo} ${pinned ? '고정' : '고정 해제'}`; }
    if (restore) { const v = await api('POST', `/flows/${id}/versions/${versionNo}/restore`); return `복원: v${versionNo} → 새 버전 v${v.versionNo}`; }
    return `v${versionNo}\n` + json(await api('GET', `/flows/${id}/versions/${versionNo}`));
}));
function execSummary(ex, opts) {
    const lines = [`실행 ${ex.id} · ${ex.status}${ex.error ? ` · ${ex.error}` : ''} · ${ex.startedAt}${ex.finishedAt ? ` → ${ex.finishedAt}` : ''}`];
    for (const n of ex.nodes ?? []) {
        lines.push(`- ${n.nodeId}${n.nodeName ? `(${n.nodeName})` : ''} ${n.nodeType ?? ''} ${n.status}${n.ok ? ' ✓' : ' ✕'}${n.httpStatus ? ` HTTP ${n.httpStatus}` : ''}${n.durationMs != null ? ` ${n.durationMs}ms` : ''}`);
        const lim = opts?.full ? 4000 : 500;
        if (!n.ok || opts?.full) {
            if (n.requestText)
                lines.push(`   요청: ${clip(n.requestText, lim)}`);
            if (n.responseText)
                lines.push(`   응답: ${clip(n.responseText, lim)}`);
        }
        else if (n.responseText && n.nodeType !== 'start' && n.nodeType !== 'end')
            lines.push(`   응답: ${clip(n.responseText, 200)}`);
        if (n.output && Object.keys(n.output).length)
            lines.push(`   출력: ${clip(n.output, opts?.full ? 2000 : 400)}`);
    }
    const pending = ex.pendingInput ? '입력(input) 노드' : ex.pendingForm ? '폼(form) 노드' : ex.pendingClient ? '브라우저 호출(client) 노드' : ex.pendingWait ? `콜백 대기(wait) — 수신 URL ${ex.pendingWait.receiveUrl ?? ''}` : null;
    if (pending)
        lines.push(`⏸ 대기 중: ${pending} — 브라우저(워크플로 페이지)에서 진행하거나 콜백을 보내야 합니다.`);
    return lines.join('\n');
}
tool('flow_run', {
    title: '워크플로 실행',
    description: '실행을 시작하고 끝날 때까지(최대 timeoutSec, 기본 120초) 기다린 뒤 노드별 결과·출력·실패 사유를 돌려준다. input={{키@input}} 값, envName=활성 환경 이름.',
    inputSchema: { id: z.string(), input: z.record(z.string(), z.unknown()).optional(), envName: z.string().optional(), timeoutSec: z.number().int().min(5).max(600).optional() },
}, async ({ id, input, envName, timeoutSec }) => run(async () => {
    let env;
    if (envName) {
        try {
            const list = await api('GET', '/environments');
            env = list.find((e) => e.name === envName)?.vars;
        }
        catch { /* */ }
    }
    const started = await api('POST', `/flows/${id}/runs`, { input: input ?? null, env: env ?? null, envName: envName ?? null });
    return waitDone(started, timeoutSec);
}));
/**
 * 끝나거나 대기 노드(input/form/client/wait)에서 멈출 때까지(최대 timeoutSec, 기본 120초) 폴링한 뒤 요약.
 * 재개 직후엔 대기 노드 없이 WAITING 인 순간이 있어(서버가 즉시 반환) 그건 진행 중으로 본다.
 */
async function waitDone(ex, timeoutSec) {
    const deadline = Date.now() + (timeoutSec ?? 120) * 1000;
    const busy = (e) => e.status === 'RUNNING' || e.status === 'PENDING' || (e.status === 'WAITING' && !(e.pendingInput || e.pendingForm || e.pendingClient || e.pendingWait));
    while (busy(ex) && Date.now() < deadline) {
        await sleep(500);
        ex = await api('GET', `/executions/${ex.id}`);
    }
    return execSummary(ex) + (busy(ex) ? '\n(아직 실행 중 — execution_get 으로 다시 확인)' : '');
}
tool('execution_get', { title: '실행 상세', description: '실행 id 의 노드별 요청/응답/출력(full=true 면 전문 전체).', inputSchema: { id: z.string(), full: z.boolean().optional() } }, async ({ id, full }) => run(async () => execSummary(await api('GET', `/executions/${id}`), { full })));
tool('execution_list', {
    title: '실행 이력',
    description: '최근 실행 목록. flowId·status(PENDING/RUNNING/WAITING/SUCCEEDED/FAILED…)·workspace 로 좁힌다.',
    inputSchema: { flowId: z.string().optional(), status: z.string().optional(), workspace: WS_ARG, limit: z.number().int().min(1).max(100).optional() },
}, async ({ flowId, status, workspace, limit }) => run(async () => {
    const w = workspace ? await wsOf(workspace) : null;
    const l = await api('GET', '/executions', undefined, { flowId, status, workspaceId: w?.q, limit: String(limit ?? 20) });
    const items = Array.isArray(l) ? l : (l.items ?? l.content ?? []);
    return items.length ? items.map((e) => `${e.id} ${e.status} ${e.flowName ?? ''} [${e.flowId}] ${e.startedAt}${e.error ? ` · ${clip(e.error, 120)}` : ''}`).join('\n') : '(실행 없음)';
}));
tool('execution_resume', {
    title: '대기 중 실행 재개',
    description: '멈춘 실행을 이어 간다. 입력(input) 노드: values 로 값을 넣는다. 브라우저 호출(client) 노드: 그 HTTP 요청을 여기서 대신 보내 결과로 재개. 폼(form) 노드: 팝업이 열린 것으로 처리하고 폼 명세(action/fields)를 돌려주니 http_request 로 제출하면 콜백으로 이어진다. wait 노드는 receiveUrl 로 POST 하면 스스로 재개. abort=true 면 중단.',
    inputSchema: { id: z.string(), values: z.record(z.string(), z.unknown()).optional(), abort: z.boolean().optional(), timeoutSec: z.number().int().min(5).max(600).optional() },
}, async ({ id, values, abort, timeoutSec }) => run(async () => {
    const ex = await api('GET', `/executions/${id}`);
    const p = ex.pendingInput ?? ex.pendingForm ?? ex.pendingClient;
    if (!p)
        return `대기 중인 노드가 없습니다 (${ex.status})${ex.pendingWait ? ` · wait 노드 대기 중 — 콜백을 ${ex.pendingWait.receiveUrl ?? '(relay 미설정)'} 로 POST 하면 스스로 재개` : ''}`;
    let body, note = '';
    if (abort)
        body = { nodeId: p.nodeId, error: 'MCP 에서 중단', aborted: true };
    else if (ex.pendingInput)
        body = { nodeId: p.nodeId, formValues: values ?? {} };
    else if (ex.pendingForm) {
        body = { nodeId: p.nodeId, popupOpened: true };
        note = `\n폼: ${p.method} ${p.action}\n필드: ${(p.fields ?? []).map((f) => `${f.key}=${f.value}`).join(' · ') || '(없음)'}\n→ http_request 로 이 폼을 제출하면 콜백으로 진행됩니다.`;
    }
    else {
        // client 노드 — 브라우저가 할 호출을 서버가 대신(사용자 PC 가 아니라 FlowLink 서버에서 나간다)
        try {
            const r = await fetch(p.url, { method: p.method, headers: p.headers ?? {}, body: p.body && p.method !== 'GET' && p.method !== 'HEAD' ? p.body : undefined });
            body = { nodeId: p.nodeId, status: r.status, body: await r.text() };
        }
        catch (e) {
            body = { nodeId: p.nodeId, error: e instanceof Error ? e.message : String(e) };
        }
    }
    return (await waitDone(await api('POST', `/executions/${id}/resume`, body), timeoutSec)) + note;
}));
tool('execution_rerun', { title: '같은 조건으로 재실행', description: '실행 id 와 같은 버전·입력으로 다시 실행하고 끝까지 기다린다.', inputSchema: { id: z.string(), timeoutSec: z.number().int().min(5).max(600).optional() } }, async ({ id, timeoutSec }) => run(async () => waitDone(await api('POST', `/executions/${id}/rerun`), timeoutSec)));
tool('node_run', {
    title: '노드 하나만 실행',
    description: '워크플로의 노드 하나를 새 컨텍스트로 즉석 실행(이력 미저장) — HTTP/TCP 노드 설정을 맞출 때. input={{키@input}} 값, upstream={소스노드ID:{키:값}} 로 상류 출력 대입. 대기/폼/입력/클라이언트 노드는 불가.',
    inputSchema: { flowId: z.string(), nodeId: z.string(), input: z.record(z.string(), z.unknown()).optional(), envName: z.string().optional(), upstream: z.record(z.string(), z.record(z.string(), z.unknown())).optional() },
}, async ({ flowId, nodeId, input, envName, upstream }) => run(async () => {
    const r = await api('POST', `/flows/${flowId}/nodes/${encodeURIComponent(nodeId)}/run`, { input: input ?? null, envName: envName ?? null, upstream: upstream ?? null });
    return [`${nodeId} ${r.ok ? '✓' : '✕'}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ''}${r.durationMs != null ? ` ${r.durationMs}ms` : ''}`,
        r.requestText ? `요청: ${clip(r.requestText, 1500)}` : '', r.responseText ? `응답: ${clip(r.responseText, 1500)}` : '', r.output != null ? `출력: ${clip(r.output, 1000)}` : ''].filter(Boolean).join('\n');
}));
tool('suite_run', {
    title: '여러 워크플로 일괄 실행(스위트)',
    description: '폴더(workspace+folder) 안의 워크플로 전부, 또는 flowIds 를 한 번에 실행하고 끝날 때까지(최대 timeoutSec, 기본 180초) 기다려 성공/실패 표를 준다.',
    inputSchema: { workspace: WS_ARG, folder: FOLDER_ARG, flowIds: z.array(z.string()).optional(), timeoutSec: z.number().int().min(5).max(900).optional() },
}, async ({ workspace, folder, flowIds, timeoutSec }) => run(async () => {
    let folderId = null;
    if (!flowIds?.length) {
        const f = await folderOf(await wsOf(workspace), folder);
        if (!f) throw new Error('folder(워크스페이스의 폴더) 또는 flowIds 가 필요합니다');
        folderId = f.id;
    }
    const items = await api('POST', '/suites/run', { flowIds: flowIds?.length ? flowIds : null, folderId });
    const deadline = Date.now() + (timeoutSec ?? 180) * 1000;
    const rows = [];
    for (const it of items) {
        if (!it.executionId) { rows.push(`✕ ${it.flowName}: ${it.status}${it.error ? ` · ${it.error}` : ''}`); continue; }
        let ex = await api('GET', `/executions/${it.executionId}`);
        while (ex.status === 'RUNNING' && Date.now() < deadline) { await sleep(500); ex = await api('GET', `/executions/${it.executionId}`); }
        const bad = (ex.nodes ?? []).find((n) => !n.ok);
        rows.push(`${ex.status === 'SUCCEEDED' ? '✓' : ex.status === 'RUNNING' ? '…' : '✕'} ${it.flowName} [${it.executionId}] ${ex.status}${ex.error ? ` · ${clip(ex.error, 120)}` : bad ? ` · ${bad.nodeId} 실패` : ''}`);
    }
    return `${rows.filter((r) => r.startsWith('✓')).length}/${rows.length} 성공\n${rows.join('\n')}`;
}));
// ---------- 환경 변수 ----------
tool('env_list', { title: '환경 목록', description: '실행 환경(dev/staging/prod)과 변수({{ 키@env }}).', inputSchema: {} }, async () => run(async () => { const l = await api('GET', '/environments'); return l.length ? l.map((e) => `${e.name}: ${Object.entries(e.vars ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '(비어 있음)'}`).join('\n') : '(환경 없음)'; }));
tool('env_put', { title: '환경 변수 저장', description: '환경 name 의 변수를 통째로 교체(없으면 생성). 비밀은 여기 말고 시크릿 볼트(화면)에 — secret_list 로 이름 확인.', inputSchema: { name: z.string().min(1), vars: z.record(z.string(), z.string()) } }, async ({ name, vars }) => run(async () => { const e = await api('PUT', `/environments/${encodeURIComponent(name)}`, { vars }); return `저장: ${e.name} (${Object.keys(e.vars ?? {}).length}개)`; }));
tool('env_rename', { title: '환경 이름 변경', inputSchema: { name: z.string().min(1), to: z.string().min(1) } }, async ({ name, to }) => run(async () => { const e = await api('POST', `/environments/${encodeURIComponent(name)}/rename`, { to }); return `이름 변경: ${name} → ${e.name}`; }));
tool('env_delete', { title: '환경 삭제', inputSchema: { name: z.string().min(1) } }, async ({ name }) => run(async () => { await api('DELETE', `/environments/${encodeURIComponent(name)}`); return '삭제됨: ' + name; }));
tool('flow_run_input', {
    title: '워크플로 기본 실행 입력',
    description: '워크플로에 저장된 기본 실행 입력({{키@input}} 기본값) 조회, vars 를 주면 통째로 교체.',
    inputSchema: { id: z.string(), vars: z.record(z.string(), z.string()).optional() },
}, async ({ id, vars }) => run(async () => {
    const r = vars ? await api('PUT', `/flows/${id}/run-input`, { vars }) : await api('GET', `/flows/${id}/run-input`);
    return `${vars ? '저장 · ' : ''}기본 입력: ${Object.entries(r.vars ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '(없음)'}`;
}));
tool('secret_list', { title: '시크릿 이름 목록', description: '시크릿 볼트의 이름(값은 안 보임)과 환경 스코프 — {{ 이름@secret }} 으로 참조. 값 저장은 화면에서.', inputSchema: {} }, async () => run(async () => {
    const l = await api('GET', '/secrets');
    return l.length ? l.map((s) => `${s.name}${s.environment && s.environment !== '*' ? ` (${s.environment})` : ' (공통)'}`).join('\n') : '(시크릿 없음)';
}));
// ---------- 기동 ----------
// ---------- 플러그인(변환·코덱) ----------
const ioStr = (io) => (io ?? []).map((p) => `${p.key}:${p.type}`).join(',') || '-';
const paramStr = (ps) => (ps ?? []).map((p) => `${p.key}(${p.type}${p.defaultValue ? '=' + p.defaultValue : ''}${p.options?.length ? ' [' + p.options.join('|') + ']' : ''})`).join(' ');
tool('plugin_list', {
    title: '플러그인 목록(변환·코덱)',
    description: 'TRANSFORM 노드에 쓰는 변환 플러그인과 Mock/전문에 쓰는 코덱 플러그인 목록(id·설명·입출력 포트·파라미터). 플러그인은 JAR 로 올린 것만 있고 목록이 비어 있으면 TRANSFORM 노드·코덱을 만들지 마라(업로드는 화면에서 관리자).',
    inputSchema: {},
}, async () => run(async () => {
    const [transforms, codecs] = await Promise.all([
        api('GET', '/transforms').catch(() => []),
        api('GET', '/codecs').catch(() => []),
    ]);
    const lines = [];
    lines.push(`# 변환(transform) — TRANSFORM 노드 transformId (${transforms.length})`);
    if (transforms.length)
        for (const t of transforms)
            lines.push(`- ${t.id} [${t.label}] — ${clip(t.description, 120)}\n   입력 ${ioStr(t.inputs)} → 출력 ${ioStr(t.outputs)}${(t.params ?? []).length ? '\n   파라미터 ' + paramStr(t.params) : ''}`);
    else
        lines.push('  (없음 — TRANSFORM 노드를 만들지 마라)');
    lines.push(`# 코덱(codec) — Mock 코덱·전문 변환 (${codecs.length})`);
    if (codecs.length)
        for (const c of codecs)
            lines.push(`- ${c.id} [${c.label}] (${c.layer})${(c.params ?? []).length ? ' · ' + paramStr(c.params) : ''}`);
    else
        lines.push('  (없음)');
    return lines.join('\n');
}));
tool('transform_preview', {
    title: '변환 미리보기',
    description: '변환 플러그인을 샘플 입력(inputs)·설정(config)으로 실행해 결과를 확인한다(순수 계산, 네트워크 없음). TRANSFORM 노드를 배선하기 전에 config 를 맞추는 용도.',
    inputSchema: { id: z.string(), inputs: z.record(z.string(), z.string()).optional(), config: z.record(z.string(), z.string()).optional() },
}, async ({ id, inputs, config }) => run(async () => {
    const r = await api('POST', `/transforms/${encodeURIComponent(id)}/preview`, { inputs: inputs ?? {}, config: config ?? {} });
    if (!r.ok)
        return `⚠ ${r.error ?? '변환 실패'}`;
    return Object.entries(r.outputs ?? {}).map(([k, v]) => `${k} = ${clip(v, 400)}`).join('\n') || '(출력 없음)';
}));
// ---------- 실제 HTTP 요청(테스트) ----------
tool('http_request', {
    title: 'HTTP 요청 보내기(테스트)',
    description: 'Mock 엔드포인트·wait 콜백·웹훅·외부 URL 에 실제 HTTP 요청을 보내 응답을 확인한다. 에이전트는 이걸 쓰고 curl/파이썬으로 직접 쏘지 마라. '
        + 'HTTP Mock 테스트: mock_list 가 보여주는 base URL(예: {서버}/mock/{slug}) 뒤에 라우트 경로를 붙여 호출 → 템플릿 렌더 결과가 응답으로 온다. '
        + 'url 이 "/" 로 시작하면 FlowLink 주소에 붙인다(예: /mock/pay/orders). 같은 서버면 로그인 토큰을 자동 첨부(Mock 게이트웨이는 무시). '
        + '요청은 FlowLink 서버에서 나간다 — localhost 는 서버 자신이지 사용자 PC 가 아니다.',
    inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
        timeoutSec: z.number().int().min(1).max(120).optional(),
    },
}, async ({ method, url, headers, body, timeoutSec }) => run(async () => {
    const target = /^https?:\/\//.test(url) ? url : BASE + (url.startsWith('/') ? '' : '/') + url;
    const h = { ...(headers ?? {}) };
    const lc = Object.keys(h).map((k) => k.toLowerCase());
    let payload;
    if (body != null) {
        if (typeof body === 'string')
            payload = body;
        else {
            payload = JSON.stringify(body);
            if (!lc.includes('content-type'))
                h['Content-Type'] = 'application/json';
        }
    }
    // 같은 오리진이면 로그인 토큰 첨부(API 경로는 인증 필요, Mock/relay/hooks 는 무시). 외부 URL 엔 절대 첨부하지 않는다.
    if (target.startsWith(BASE + '/') && auth.token() && !lc.includes('authorization'))
        h.Authorization = `Bearer ${auth.token()}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (timeoutSec ?? 30) * 1000);
    let r;
    try {
        r = await fetch(target, { method: method ?? 'GET', headers: h, body: payload, signal: ctl.signal, redirect: 'manual' });
    }
    finally {
        clearTimeout(timer);
    }
    const text = await r.text();
    const ct = r.headers.get('content-type') ?? '';
    const loc = r.headers.get('location');
    const line = `${method ?? 'GET'} ${target} → HTTP ${r.status}${ct ? ` · ${ct}` : ''}${loc ? ` · Location: ${loc}` : ''}`;
    return `${line}\n${clip(text, 2000) || '(빈 응답)'}`;
}));
// ---------- 기동 ----------
// Streamable HTTP, 세션 없음: 요청마다 새 McpServer+transport 를 만들어 처리하고 응답이 끝나면 닫는다(동시 요청 간 request id 충돌 방지).
// 인증은 gate(oauth.js): github 모드면 유효 Bearer 없인 401 → 클라이언트가 OAuth 로그인. 통과한 토큰은 요청 컨텍스트에 실어 REST 로 그대로 넘긴다.
const port = Number(process.env.FLOWLINK_MCP_PORT || 18090);
const host = process.env.FLOWLINK_MCP_HOST || '0.0.0.0';
const app = express();
app.use(cors());
app.use(oauthRouter);
app.get('/health', (req, res) => res.json({ ok: true, name: 'flowlink-mcp', version: VERSION, flowlink: BASE }));
app.post('/mcp', express.json({ limit: '8mb' }), async (req, res) => {
    const g = await gate(req, res);
    if (!g.ok) return;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
        await server.connect(transport);
        await withToken(g.token, () => transport.handleRequest(req, res, req.body));
    }
    catch (e) {
        if (!res.headersSent) res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
        else res.end();
    }
});
// 세션이 없으니 GET(SSE 알림 스트림)·DELETE(세션 종료)는 의미가 없다 — 스펙이 허용하는 405.
app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'stateless — POST /mcp 만 받는다' }));
app.use((req, res) => res.status(404).json({ error: 'not found — MCP 엔드포인트는 /mcp' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => res.status(err.status ?? 500).json({ error: err instanceof Error ? err.message : String(err) }));
app.listen(port, host, () => console.error(`flowlink-mcp v${VERSION} http://${host}:${port}/mcp → ${BASE}`));
