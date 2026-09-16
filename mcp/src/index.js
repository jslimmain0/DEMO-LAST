#!/usr/bin/env node
// FlowLink MCP 서버(stdio) — 에이전트가 프로토콜·Mock·워크플로를 만들고, 실행하고, 로그를 관찰한다.
//   실행: FLOWLINK_URL=http://localhost:8888 node mcp/src/index.js   (설치형: npm i -g http://<host>:8888/mcp/flowlink-mcp.tgz → flowlink-mcp)
//   순수 JS(빌드 없음) — 설치된 패키지는 node_modules 아래라 Node 가 .ts 타입 스트리핑을 거부하므로 소스가 JS 다.
//   인증: dev 모드는 불필요. github 모드는 flowlink_login → flowlink_login_wait (토큰은 ~/.flowlink/mcp-token.json), 또는 FLOWLINK_TOKEN.
// 툴은 REST 1:1 이 아니라 작업 단위이고, 응답은 에이전트 컨텍스트를 아끼려 짧은 텍스트 요약이다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ApiError, BASE, api, auth, sleep } from "./client.js";
const server = new McpServer({ name: 'flowlink', version: '0.1.0' });
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (e) => ({ content: [{ type: 'text', text: `⚠ ${e instanceof ApiError ? `HTTP ${e.status}: ` : ''}${e instanceof Error ? e.message : String(e)}` }], isError: true });
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
server.registerTool('flowlink_status', {
    title: 'FlowLink 상태',
    description: '연결된 FlowLink 주소·인증 모드·로그인 상태·승인 여부. 다른 툴이 403 이면 먼저 이걸로 확인.',
    inputSchema: {},
}, async () => run(async () => {
    const cfg = await api('GET', '/auth/config');
    let me = null;
    try {
        me = await api('GET', '/admin/me');
    }
    catch { /* 게스트 */ }
    const lines = [`url: ${BASE}`, `auth mode: ${cfg.mode ?? (cfg.enabled ? 'github' : 'none')}`];
    if (cfg.mode === 'github')
        lines.push(`login: ${auth.hasToken() ? (auth.login() ?? '(토큰 있음)') : '없음(게스트) — 프로토콜/환경 저장은 flowlink_login 필요'}`);
    else
        lines.push('login: 불필요(dev 모드 — 전권)');
    if (me)
        lines.push(`status: ${me.myStatus ?? '?'}${me.admin ? ' · ADMIN' : ''}${me.pendingCount ? ` · 승인 대기 ${me.pendingCount}명` : ''}`);
    return lines.join('\n');
}));
server.registerTool('flowlink_login', {
    title: 'GitHub 로그인 시작',
    description: 'github 모드에서 디바이스 코드를 발급한다. 사용자에게 verificationUri 를 열어 userCode 를 입력하라고 안내한 뒤 flowlink_login_wait(sessionId) 를 호출.',
    inputSchema: {},
}, async () => run(async () => {
    const cfg = await api('GET', '/auth/config');
    if (cfg.mode !== 'github')
        return 'dev 모드 — 로그인이 필요 없습니다.';
    const d = await api('POST', '/auth/github/device/start', {});
    return [`사용자에게 안내: 브라우저에서 ${d.verificationUri} 를 열고 코드 **${d.userCode}** 를 입력하세요(${Math.floor((d.expiresIn ?? 900) / 60)}분 유효).`,
        `입력이 끝나면 flowlink_login_wait 를 sessionId="${d.sessionId}" 로 호출.`].join('\n');
}));
server.registerTool('flowlink_login_wait', {
    title: 'GitHub 로그인 완료 대기',
    description: 'flowlink_login 의 sessionId 로 승인 완료를 기다려 토큰을 저장한다(최대 timeoutSec, 기본 120초). 미완이면 다시 호출.',
    inputSchema: { sessionId: z.string(), timeoutSec: z.number().int().min(5).max(600).optional() },
}, async ({ sessionId, timeoutSec }) => run(async () => {
    const deadline = Date.now() + (timeoutSec ?? 120) * 1000;
    while (Date.now() < deadline) {
        const p = await api('GET', '/auth/github/device/poll', undefined, { session: sessionId });
        if (p.status === 'ready') {
            auth.set(p.token, p.login ?? null);
            let st = '';
            try {
                const me = await api('GET', '/admin/me');
                st = me.myStatus ?? '';
            }
            catch { /* */ }
            return `로그인 완료: ${p.login}${st ? ` (상태 ${st}${st === 'PENDING' ? ' — 관리자 승인 전까지 프로토콜/환경 저장은 403' : ''})` : ''}. 토큰을 저장했습니다.`;
        }
        if (p.status === 'error')
            throw new Error(p.error || '로그인 실패');
        await sleep(5000);
    }
    return '아직 승인되지 않았습니다 — 사용자가 코드를 입력한 뒤 다시 flowlink_login_wait 를 호출하세요.';
}));
server.registerTool('flowlink_logout', { title: '토큰 삭제', description: '저장된 로그인 토큰을 지운다.', inputSchema: {} }, async () => run(async () => { auth.clear(); return '토큰을 지웠습니다.'; }));
// ---------- 가이드(스키마 원문) ----------
server.registerTool('flowlink_guide', {
    title: '규격 가이드',
    description: '워크플로 그래프(flow)·프로토콜(protocol)·HTTP Mock(mock) JSON 규격과 에이전트 규약(rules) 원문. 무언가 만들기 전에 해당 topic 을 한 번 읽는다.',
    inputSchema: { topic: z.enum(['flow', 'protocol', 'mock', 'rules', 'all']) },
}, async ({ topic }) => run(async () => {
    const s = await api('GET', '/schemas');
    if (topic === 'all')
        return Object.entries(s).map(([k, v]) => `# ${k}\n${v}`).join('\n\n');
    return s[topic] ?? `(${topic} 없음)`;
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
server.registerTool('protocol_list', { title: '프로토콜 목록', description: '저장된 고정길이 전문 프로토콜 목록(id·이름·인코딩·전문 수).', inputSchema: {} }, async () => run(async () => { const l = await api('GET', '/protocols'); return l.length ? l.map((p) => `${p.name} [${p.id}] ${p.encoding} · 전문 ${p.messageCount}`).join('\n') : '(프로토콜 없음)'; }));
server.registerTool('protocol_get', { title: '프로토콜 조회', description: 'id 또는 name 으로 프로토콜 spec JSON 을 가져온다.', inputSchema: { id: z.string().optional(), name: z.string().optional() } }, async (ref) => run(async () => { const p = await findProtocol(ref); if (!p)
    throw new Error('프로토콜 없음'); const d = await api('GET', `/protocols/${p.id}`); return protocolSummary(d) + '\n' + json(d.spec); }));
server.registerTool('protocol_upsert', {
    title: '프로토콜 생성/갱신',
    description: '이름이 있으면 갱신, 없으면 생성. spec 은 flowlink_guide(protocol) 규격(JSON 객체 또는 JSON 문자열). 검증 실패는 서버 메시지로 돌려준다.',
    inputSchema: { name: z.string().min(1), spec: jsonArg },
}, async ({ name, spec }) => run(async () => {
    const existing = await findProtocol({ name });
    const d = existing ? await api('PUT', `/protocols/${existing.id}`, { spec }) : await api('POST', '/protocols', { name, spec });
    return `${existing ? '갱신' : '생성'}: ` + protocolSummary(d);
}));
server.registerTool('protocol_preview', {
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
server.registerTool('protocol_delete', { title: '프로토콜 삭제', description: 'id 로 삭제(참조하는 노드/Mock 은 실행 시 실패).', inputSchema: { id: z.string() } }, async ({ id }) => run(async () => { await api('DELETE', `/protocols/${id}`); return '삭제됨'; }));
// ---------- Mock ----------
async function fleet() { return api('GET', '/mock-servers/fleet'); }
async function findMock(slug) { const f = await fleet(); return f.servers.find((s) => s.slug === slug) ?? null; }
function mockLine(s, f) {
    const where = s.kind === 'TCP' ? `:${s.tcpPort ?? '?'} ${s.listening ? 'LISTENING' : s.listenError ? 'FAILED(' + s.listenError + ')' : 'OFF'}` : `${BASE}${f.contextPath ?? ''}/mock/${s.slug}`;
    const cfg = s.kind === 'TCP' ? `프로토콜 ${s.protocolName ?? '없음'} · 규칙 ${s.tcpRuleCount ?? 0}${s.upstream ? ` · proxy→${s.upstream}` : ''}` : `라우트 ${s.routeCount ?? 0}${(s.routeLabels ?? []).length ? ' (' + s.routeLabels.slice(0, 4).join(', ') + ')' : ''}`;
    return `${s.name} [${s.slug}] ${s.kind} ${s.enabled ? 'on' : 'off'} ${where} · ${cfg}${s.lastRequestAt ? ` · 최근요청 ${s.lastRequestAt}` : ''}${s.unmatchedRequests ? ` · 무매칭 ${s.unmatchedRequests}` : ''}`;
}
server.registerTool('mock_list', { title: 'Mock 목록', description: '모든 워크스페이스의 Mock 서버(종류·켜짐·주소/포트·리스너 상태·프로토콜·최근 요청).', inputSchema: {} }, async () => run(async () => { const f = await fleet(); return f.servers.length ? f.servers.map((s) => mockLine(s, f)).join('\n') : '(Mock 없음)'; }));
server.registerTool('mock_get', { title: 'Mock 조회', description: 'slug 로 Mock spec JSON 을 가져온다.', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => { const m = await findMock(slug); if (!m)
    throw new Error('Mock 없음: ' + slug); const d = await api('GET', `/mock-servers/${m.id}`); return `${d.name} [${d.slug}] ${d.kind} v${d.currentVersion ?? 0}\n` + json(d.spec); }));
server.registerTool('mock_upsert', {
    title: 'Mock 생성/갱신',
    description: 'slug 가 있으면 spec 갱신, 없으면 생성 후 spec 저장. HTTP spec 은 flowlink_guide(mock) 규격, TCP spec 은 {"tcp":{"port","protocolId","upstream","timeoutMs","rules":[{"id","when":[{"field","op","value"}],"then":{"mode":"mock|proxy","fields":{...}},"fault":{...}}]}}. 저장 즉시 서빙/리스너 반영.',
    inputSchema: { name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'slug 는 소문자·숫자·하이픈 3~40자'), type: z.enum(['HTTP', 'TCP']), spec: jsonArg, enabled: z.boolean().optional(), workspaceId: z.string().optional() },
}, async ({ name, slug, type, spec, enabled, workspaceId }) => run(async () => {
    let m = await findMock(slug);
    let created = false;
    if (!m) {
        const d = await api('POST', '/mock-servers', { name, slug, type, workspaceId: workspaceId ?? null });
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
server.registerTool('mock_send', {
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
server.registerTool('mock_log', {
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
server.registerTool('mock_delete', { title: 'Mock 삭제', description: 'slug 로 Mock 삭제(리스너 닫힘).', inputSchema: { slug: z.string() } }, async ({ slug }) => run(async () => { const m = await findMock(slug); if (!m)
    throw new Error('Mock 없음: ' + slug); await api('DELETE', `/mock-servers/${m.id}`); return '삭제됨: ' + slug; }));
// ---------- 워크플로 · 실행 ----------
server.registerTool('flow_list', { title: '워크플로 목록', description: '워크플로 목록(id·이름·노드 수·수정 시각). workspaceId 생략=공용.', inputSchema: { workspaceId: z.string().optional() } }, async ({ workspaceId }) => run(async () => { const l = await api('GET', '/flows', undefined, { workspaceId }); return l.length ? l.map((f) => `${f.name} [${f.id}] v${f.currentVersion} 노드 ${f.nodeCount} · ${f.updatedAt}`).join('\n') : '(워크플로 없음)'; }));
server.registerTool('flow_get', { title: '워크플로 조회', description: 'id 로 현재 그래프 JSON(nodes/edges)을 가져온다.', inputSchema: { id: z.string() } }, async ({ id }) => run(async () => { const d = await api('GET', `/flows/${id}`); return `${d.name} [${d.id}] v${d.currentVersion}\n` + json(d.graph); }));
server.registerTool('flow_upsert', {
    title: '워크플로 저장',
    description: 'graph(flowlink_guide(flow) 규격: nodes/edges, START·END 필수)를 새 버전으로 저장. id 없으면 name 으로 새 워크플로 생성. 검증 실패는 서버 메시지.',
    inputSchema: { id: z.string().optional(), name: z.string().optional(), graph: jsonArg, note: z.string().optional(), workspaceId: z.string().optional() },
}, async ({ id, name, graph, note, workspaceId }) => run(async () => {
    let flowId = id;
    if (!flowId) {
        if (!name)
            throw new Error('name 또는 id 가 필요합니다');
        const c = await api('POST', '/flows', { name, description: null, folderId: null, workspaceId: workspaceId ?? null });
        flowId = c.id;
    }
    const v = await api('POST', `/flows/${flowId}/versions`, { graph, note: note ?? 'mcp', pinned: false });
    const nodes = graph.nodes?.length ?? 0;
    return `저장: flow ${flowId} v${v.versionNo ?? v.currentVersion ?? '?'} · 노드 ${nodes} · 편집기 ${BASE}/flows/${flowId}`;
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
server.registerTool('flow_run', {
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
    const deadline = Date.now() + (timeoutSec ?? 120) * 1000;
    let ex = started;
    while (ex.status === 'RUNNING' && Date.now() < deadline) {
        await sleep(500);
        ex = await api('GET', `/executions/${started.id}`);
    }
    return execSummary(ex) + (ex.status === 'RUNNING' ? '\n(아직 실행 중 — execution_get 으로 다시 확인)' : '');
}));
server.registerTool('execution_get', { title: '실행 상세', description: '실행 id 의 노드별 요청/응답/출력(full=true 면 전문 전체).', inputSchema: { id: z.string(), full: z.boolean().optional() } }, async ({ id, full }) => run(async () => execSummary(await api('GET', `/executions/${id}`), { full })));
server.registerTool('execution_list', { title: '실행 이력', description: '최근 실행 목록(flowId 로 좁힐 수 있음).', inputSchema: { flowId: z.string().optional(), limit: z.number().int().min(1).max(100).optional() } }, async ({ flowId, limit }) => run(async () => {
    const l = await api('GET', '/executions', undefined, { flowId, limit: String(limit ?? 20) });
    const items = Array.isArray(l) ? l : (l.items ?? l.content ?? []);
    return items.length ? items.map((e) => `${e.id} ${e.status} flow=${e.flowId} ${e.startedAt}${e.error ? ` · ${clip(e.error, 120)}` : ''}`).join('\n') : '(실행 없음)';
}));
// ---------- 환경 변수 ----------
server.registerTool('env_list', { title: '환경 목록', description: '실행 환경(dev/staging/prod)과 변수({{ 키@env }}).', inputSchema: {} }, async () => run(async () => { const l = await api('GET', '/environments'); return l.length ? l.map((e) => `${e.name}: ${Object.entries(e.vars ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') || '(비어 있음)'}`).join('\n') : '(환경 없음)'; }));
server.registerTool('env_put', { title: '환경 변수 저장', description: '환경 name 의 변수를 통째로 교체(없으면 생성). 비밀은 여기 말고 시크릿 볼트(화면)에.', inputSchema: { name: z.string().min(1), vars: z.record(z.string(), z.string()) } }, async ({ name, vars }) => run(async () => { const e = await api('PUT', `/environments/${encodeURIComponent(name)}`, { vars }); return `저장: ${e.name} (${Object.keys(e.vars ?? {}).length}개)`; }));
// ---------- 기동 ----------
const transport = new StdioServerTransport();
await server.connect(transport);
