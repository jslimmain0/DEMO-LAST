// PC + Docker 실행 경계/접근 보호/개인 저장소 복원. Node 24, Docker, 미리 빌드한 jar/image 필요.
// node test/agent-smoke.ts [--bundle ../backend/build/desktop/FlowLink]
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { createServer as httpServer } from 'node:http'
import { createServer as tcpServer, type AddressInfo } from 'node:net'
import { readFileSync, mkdtempSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const listen = (srv: ReturnType<typeof tcpServer> | ReturnType<typeof httpServer>, port = 0) =>
  new Promise<number>((r, reject) => { srv.once('error', reject); srv.listen(port, '127.0.0.1', () => r((srv.address() as AddressInfo).port)) })

async function probe(origin: string, httpPort = 0, tcpPort = 0) {
  const http = httpServer((req, res) => {
    assert.equal(req.headers['x-flowlink-local'], undefined, '관리 키가 테스트 대상에 유출됨')
    if (req.url === '/euc-kr') { res.end(Buffer.from('b0a1b3aab4d9', 'hex')); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ origin, secretOk: req.headers['x-test-secret'] === 'test-private-value' }))
  })
  const tcp = tcpServer(socket => {
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length < 14) return
      assert.equal(bytes.subarray(0, 6).toString(), '001401')
      socket.end('001402' + origin.padEnd(8))
    })
  })
  return { httpPort: await listen(http, httpPort), tcpPort: await listen(tcp, tcpPort), close: () => { http.close(); tcp.close() } }
}
if (process.argv[2] === '--probe') {
  await probe(process.argv[3], Number(process.argv[4]), Number(process.argv[5]))
  console.log('probe ready')
} else {
  await scenario()
}

async function scenario() {
  mkdirSync(join(root, '.run'), { recursive: true })
  const data = mkdtempSync(join(root, '.run/agent-smoke-'))
  const agentFile = join(data, 'agent.json')
  const bundleAt = process.argv.indexOf('--bundle')
  const bundle = bundleAt < 0 ? null : resolve(process.argv[bundleAt + 1])
  const command = bundle ? join(bundle, 'FlowLink.exe') : 'java'
  const node = bundle ? join(bundle, 'app/node/node.exe') : process.execPath
  const script = bundle ? join(bundle, 'app/mcp/src/index.js') : join(root, 'mcp/src/index.js')
  // 설치된 Java/Node가 PATH에 없어도 패키지가 단독 실행되는지 확인한다.
  const cleanEnv = { ...process.env, ...(bundle ? { PATH: join(process.env.SystemRoot!, 'System32') } : {}) }
  const args = [...(bundle ? [] : ['-jar', join(root, 'backend/build/libs/flowlink.jar')]),
    '--spring.profiles.active=local,desktop', `--flowlink.desktop.data-dir=${data.replaceAll('\\', '/')}`,
    '--flowlink.desktop.tray=false', '--flowlink.desktop.open-browser=false']
  const portProbe = tcpServer(); const port = await listen(portProbe); await new Promise<void>(r => portProbe.close(() => r()))
  args.push(`--server.port=${port}`, '--flowlink.execution.ssrf.allow-loopback=true', '--flowlink.execution.capture.request-response-bodies=true')
  const base = `http://127.0.0.1:${port}`
  const agent = () => JSON.parse(readFileSync(agentFile, 'utf8'))
  const container = 'flowlink-agent-smoke-' + Date.now()
  const fixtureSecret = 'agent-test-only-signing-key'
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const jwtBody = b64({ alg: 'HS256' }) + '.' + b64({ sub: 'agent-tester', preferred_username: 'agent-tester', tenant: 'default',
    realm_access: { roles: ['admin', 'editor', 'platform-admin'] }, iss: 'flowlink', exp: Math.floor(Date.now() / 1000) + 1800 })
  const jwt = jwtBody + '.' + createHmac('sha256', createHash('sha256').update(fixtureSecret).digest()).update(jwtBody).digest('base64url')
  let proc: ChildProcess | undefined; let dockerProbe: ChildProcess | undefined
  const clients: Client[] = []
  let checks = 0
  const ok = (name: string) => console.log(`✓ ${++checks} ${name}`)
  const { BASE, credentials, withToken } = await import('../src/client.js')
  withToken('test-management-token', () => {
    assert.equal(credentials(BASE + '/api/v1/auth/config').Authorization, 'Bearer test-management-token')
    assert.deepEqual(credentials(BASE + '/api/../mock/test'), {})
    assert.deepEqual(credentials(BASE + '/api/%2e%2e/mock/test'), {})
    assert.deepEqual(credentials('https://other.example/api/v1'), {})
  })
  ok('URL 정규화: 경로 우회·외부 목적지에 관리 자격 증명 전달 차단')
  const launch = () => {
    const log = openSync(join(data, 'runtime.log'), 'a')
    proc = spawn(command, args, { env: cleanEnv, stdio: ['ignore', log, log], windowsHide: true })
    proc.on('error', e => console.error(e.message))
  }
  const stop = async () => {
    if (proc && proc.exitCode === null) { const p = proc; const exit = new Promise<void>(r => p.once('exit', () => r())); p.kill(); await exit }
  }
  async function ready(get: () => Promise<Response>) {
    for (let i = 0; i < 240; i++) { try { if ((await get()).ok) return } catch { /* startup */ } await sleep(500) }
    throw new Error(`기동 실패. 로그: ${data}/runtime.log`)
  }
  const localFetch = (path: string, init: RequestInit = {}) => fetch(base + path, {
    ...init, headers: { 'Content-Type': 'application/json', 'X-FlowLink-Local': agent().token, ...init.headers }, redirect: 'manual', signal: AbortSignal.timeout(5000),
  })
  async function json(get: Promise<Response>) { const r = await get; const body = await r.text(); assert.ok(r.ok, `HTTP ${r.status}: ${body}`); return body ? JSON.parse(body) : null }
  async function connect(command: string, args: string[], env?: Record<string, string>) {
    const client = new Client({ name: 'agent-smoke', version: '1' })
    await client.connect(new StdioClientTransport({ command, args, env, stderr: 'inherit' })); clients.push(client)
    return async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args })
      const text = (r.content as { text?: string }[]).map(c => c.text ?? '').join('\n')
      assert.ok(!r.isError, `${name}: ${text}`); return text
    }
  }
  const fixture = await probe('LOCAL')
  try {
    launch(); await ready(() => localFetch('/api/v1/auth/config'))
    assert.equal((await fetch(base + '/api/v1/flows')).status, 401)
    assert.equal((await localFetch('/api/v1/flows', { headers: { Origin: 'https://other.example' } })).status, 403)
    assert.equal((await fetch(base.replace('127.0.0.1', 'localhost') + '/api/v1/flows', { headers: { 'X-FlowLink-Local': agent().token } })).status, 403)
    ok('개인 관리 API: 무인증·외부 Origin·Mock origin 차단')
    const ticket = await json(localFetch('/desktop/ticket', { method: 'POST' }))
    const opened = await fetch(ticket.url, { redirect: 'manual' })
    assert.equal(opened.status, 302)
    const cookie = opened.headers.get('set-cookie')!; assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i)
    assert.equal((await fetch(base + '/', { headers: { Cookie: cookie.split(';')[0] } })).status, 200)
    assert.equal((await fetch(ticket.url)).status, 401)
    ok('화면 일회용 티켓·HttpOnly 쿠키·정적 화면·티켓 재사용 차단')
    const before = agent()
    await new Promise<void>((r, reject) => {
      const duplicate = spawn(command, args, { env: cleanEnv, stdio: 'ignore', windowsHide: true })
      duplicate.on('error', reject); duplicate.on('exit', code => code === 0 ? r() : reject(new Error('중복 기동 실패: ' + code)))
    })
    assert.equal(agent().token, before.token); ok('중복 실행: 기존 프로세스·DB 유지')
    const local = await connect(node, [script, '--stdio', '--agent-file', agentFile], cleanEnv as Record<string, string>)
    assert.match(await local('flowlink_status'), /transport: stdio[\s\S]*내 PC \(local\)/)
    assert.match(await local('http_request', { url: `http://127.0.0.1:${fixture.httpPort}/marker` }), /"origin":"LOCAL"/)
    assert.match(await local('http_request', { url: '/api/v1/auth/config' }), /"kind":"local"/)
    ok('설치된 Node의 MCP stdio 연결·PC에서 직접 HTTP 요청')

    execFileSync('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::18080', '-e', 'FLOWLINK_AUTH_GITHUB_ENABLED=true',
      '-e', `FLOWLINK_AUTH_JWT_SECRET=${fixtureSecret}`, '-e', 'FLOWLINK_H2_FILE=/tmp/server-db/flowlink',
      process.env.FLOWLINK_AGENT_TEST_IMAGE || 'flowlink-agent-test', '--spring.profiles.active=local',
      '--flowlink.execution.ssrf.allow-loopback=true', '--flowlink.execution.capture.request-response-bodies=true'], { stdio: 'pipe' })
    const mapped = execFileSync('docker', ['port', container, '18080/tcp'], { encoding: 'utf8' }).trim()
    const serverBase = 'http://' + mapped
    const remoteFetch = (path: string, init: RequestInit = {}) => fetch(serverBase + path, { ...init,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt, ...init.headers }, signal: AbortSignal.timeout(5000) })
    await ready(() => fetch(serverBase + '/api/v1/auth/config', { signal: AbortSignal.timeout(3000) }))
    assert.equal((await fetch(serverBase + '/api/v1/flows')).status, 401)
    assert.equal((await remoteFetch('/api/v1/flows', { headers: { Authorization: 'Bearer invalid' } })).status, 401)
    await json(remoteFetch('/api/v1/workspaces'))
    assert.equal((await json(remoteFetch('/api/v1/auth/config'))).runtime.kind, 'server')
    ok('Docker 서버: 로그인 없는 접근·잘못된 JWT 차단, 인증된 접근 성공')
    dockerProbe = spawn('docker', ['exec', container, 'node', '/app/mcp/test/agent-smoke.ts', '--probe', 'SERVER', String(fixture.httpPort), String(fixture.tcpPort)], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((r, reject) => { dockerProbe!.stdout!.once('data', () => r()); dockerProbe!.once('exit', code => reject(new Error('서버 probe 종료: ' + code))) })
    const remote = await connect('docker', ['exec', '-i', '-e', 'FLOWLINK_URL=http://127.0.0.1:18080', '-e', 'FLOWLINK_TOKEN=' + jwt,
      container, 'node', '/app/mcp/src/index.js', '--stdio'])
    assert.match(await remote('http_request', { url: `http://127.0.0.1:${fixture.httpPort}/marker` }), /"origin":"SERVER"/)
    ok('같은 localhost URL: 서버 MCP는 서버에서 요청')
    const spec = { encoding: 'UTF-8', includesSelf: true, lengthField: 'LEN', discriminator: 'TYPE',
      header: [{ name: 'LEN', len: 4, type: 'length' }, { name: 'TYPE', len: 2, type: 'ascii' }],
      messages: [{ key: '01', fields: [{ name: 'payload', len: 8, type: 'ascii' }] }, { key: '02', fields: [{ name: 'origin', len: 8, type: 'ascii' }] }] }
    const ids: string[] = []
    for (const [call, request, marker] of [[local, localFetch, 'LOCAL'], [remote, remoteFetch, 'SERVER']] as const) {
      await json(request('/api/v1/secrets/test-key', { method: 'PUT', body: JSON.stringify({ value: 'test-private-value' }) }))
      await call('env_put', { name: 'test', vars: { owner: marker } })
      const pid = /\[([0-9a-f-]{36})\]/.exec(await call('protocol_upsert', { name: 'origin-test', spec }))![1]
      const graph = { nodes: [{ id: 'start', type: 'start' },
        { id: 'http', type: 'http', method: 'GET', baseUrl: `http://127.0.0.1:${fixture.httpPort}`, path: '/marker', reqMode: 'server', respType: 'json',
          fields: { headers: [{ key: 'X-Test-Secret', value: '{{ test-key@secret }}' }] } },
        { id: 'kr', type: 'http', method: 'GET', baseUrl: `http://127.0.0.1:${fixture.httpPort}`, path: '/euc-kr', respType: 'text', charset: 'EUC-KR' },
        { id: 'tcp', type: 'tcp', protocolId: pid, tcpMessage: '01', tcpResponseMessage: '02', tcpHost: '127.0.0.1', tcpPort: fixture.tcpPort, tcpValues: { payload: 'hello' } },
        { id: 'env', type: 'set', vars: [{ key: 'owner', value: '{{ owner@env }}' }] }, { id: 'end', type: 'end' }],
        edges: ['start', 'http', 'kr', 'tcp', 'env'].map((from, i) => ({ from, to: ['http', 'kr', 'tcp', 'env', 'end'][i] })) }
      const id = /flow ([0-9a-f-]{36})/.exec(await call('flow_upsert', { name: '실행 출발지 검증', graph }))![1]; ids.push(id)
      const result = await call('flow_run', { id, envName: 'test', timeoutSec: 15 })
      assert.match(result, /SUCCEEDED/); assert.match(result, new RegExp(`"origin": ?"${marker}"`)); assert.match(result, /가나다/)
      assert.match(result, /"secretOk": ?true/); assert.doesNotMatch(result, /test-private-value/)
      assert.match(result, new RegExp(`"owner": ?"${marker}"`))
      ok(`${marker}: 같은 HTTP·TCP·EUC-KR 워크플로, 환경 변수·시크릿 전달/마스킹`)
    }
    assert.equal((await remoteFetch('/api/v1/flows/' + ids[0])).status, 404)
    assert.equal((await localFetch('/api/v1/flows/' + ids[1])).status, 404)
    ok('PC와 서버의 워크플로·환경·시크릿 저장소 분리')
    const waitGraph = { nodes: [{ id: 'start', type: 'start' }, { id: 'wait', type: 'wait', waitTimeoutSec: 120 }, { id: 'end', type: 'end' }], edges: [{ from: 'start', to: 'wait' }, { from: 'wait', to: 'end' }] }
    const waitId = /flow ([0-9a-f-]{36})/.exec(await local('flow_upsert', { name: '재시작 대기 복원', graph: waitGraph }))![1]
    const waited = await local('flow_run', { id: waitId, timeoutSec: 5 })
    assert.match(waited, /WAITING/)
    const executionId = /실행 ([0-9a-f-]{36})/.exec(waited)![1]
    const callback = (await json(localFetch('/api/v1/executions/' + executionId))).pendingWait.receiveUrl
    await stop(); launch()
    await ready(async () => { const r = await localFetch('/api/v1/auth/config'); return agent().token !== before.token ? r : new Response('', { status: 503 }) })
    assert.equal(agent().deviceId, before.deviceId); assert.notEqual(agent().token, before.token)
    assert.equal((await fetch(base + '/api/v1/flows', { headers: { 'X-FlowLink-Local': before.token } })).status, 401)
    assert.match(await local('flow_run', { id: ids[0], envName: 'test', timeoutSec: 15 }), /SUCCEEDED[\s\S]*"secretOk": ?true/)
    assert.equal((await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"result":"ok"}' })).status, 200)
    for (let i = 0; i < 50; i++) {
      if ((await json(localFetch('/api/v1/executions/' + executionId))).status === 'SUCCEEDED') break
      await sleep(100)
    }
    const resumed = await json(localFetch('/api/v1/executions/' + executionId))
    assert.equal(resumed.status, 'SUCCEEDED', JSON.stringify(resumed))
    ok('프로세스 재시작: DB·암호화 시크릿·WAIT 복원, 장치 ID 유지·접근 키 교체·MCP 재연결')
    console.log(`PASS ${checks} checks · ${bundle ? 'bundled Java/Node, system PATH excluded' : 'development jar'} · logs: ${data}`)
  } finally {
    for (const c of clients) await c.close().catch(() => {})
    dockerProbe?.kill(); await stop(); fixture.close()
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }) } catch { /* container not created */ }
  }
}
