#!/usr/bin/env node
/**
 * SaaS P1 e2e — OIDC(RBAC)·테넌트 격리 검증.
 *
 * 전제:
 *  - Keycloak: docker compose -f deploy/keycloak-dev.compose.yml up -d  (localhost:8081, realm flowlink)
 *  - 백엔드: H2 + issuer 로 기동
 *      SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:8081/realms/flowlink
 *
 * 유저(비번=아이디): alice(team-a admin+platform-admin) / bob(team-a editor) / carol(team-a viewer) / dave(team-b editor)
 * 실행: node e2e/saas-p1-auth.mjs
 */
const BASE = process.env.FLOWLINK_BASE || 'http://localhost:18080'
const KC = process.env.KEYCLOAK_BASE || 'http://localhost:8081'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

async function token(user) {
  const r = await fetch(`${KC}/realms/flowlink/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'flowlink-web', username: user, password: user }),
  })
  if (!r.ok) throw new Error(`토큰 발급 실패(${user}): ${r.status} ${await r.text()}`)
  return (await r.json()).access_token
}

function api(tok) {
  return async (method, path, body) => {
    const r = await fetch(`${BASE}/api/v1${path}`, {
      method,
      headers: {
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    let data = null
    try { data = await r.json() } catch { /* 본문 없음 */ }
    return { status: r.status, data }
  }
}

const MINI_GRAPH = {
  name: 'e2e-rbac',
  nodes: [
    { id: 'start001', name: '시작', type: 'start', cat: 'start', x: 0, y: 0 },
    { id: 'setnode1', name: '변수', type: 'set', cat: 'generic', x: 200, y: 0, vars: [{ key: 'greeting', value: '안녕' }] },
    { id: 'endnode1', name: '끝', type: 'end', cat: 'end', x: 400, y: 0 },
  ],
  edges: [
    { from: 'start001', to: 'setnode1' },
    { from: 'setnode1', to: 'endnode1' },
  ],
}

async function main() {
  console.log('== 토큰 발급 ==')
  const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map(token))
  const anon = api(null)
  const A = api(alice), B = api(bob), C = api(carol), D = api(dave)

  console.log('== ① 무토큰 401 ==')
  ok('GET /flows 무토큰 401', (await anon('GET', '/flows')).status === 401)
  ok('/auth/config 는 public', (await anon('GET', '/auth/config')).status === 200)

  console.log('== ② /me ==')
  const meA = (await A('GET', '/auth/me')).data
  ok('alice tenant=team-a', meA?.tenant === 'team-a', JSON.stringify(meA))
  ok('alice roles admin+platform-admin', meA?.roles?.includes('admin') && meA?.roles?.includes('platform-admin'))
  const meC = (await C('GET', '/auth/me')).data
  ok('carol roles=viewer', meC?.roles?.includes('viewer') && !meC?.roles?.includes('editor'))

  console.log('== ③ viewer 읽기전용 ==')
  ok('carol GET /flows 200', (await C('GET', '/flows')).status === 200)
  ok('carol POST /flows 403', (await C('POST', '/flows', { name: 'x' })).status === 403)
  ok('carol PUT /settings/relay 403', (await C('PUT', '/settings/relay', { value: null })).status === 403)

  console.log('== ④ editor 플로우 CRUD + 실행 ==')
  const created = await B('POST', '/flows', { name: 'e2e-rbac' })
  ok('bob 플로우 생성 201', created.status === 201, `status=${created.status}`)
  const flowId = created.data?.id
  ok('bob 버전 저장', (await B('POST', `/flows/${flowId}/versions`, { graph: MINI_GRAPH })).status < 300)
  const run = await B('POST', `/flows/${flowId}/runs`, {})
  ok('bob 실행 SUCCEEDED', run.data?.status === 'SUCCEEDED', JSON.stringify(run.data?.status))
  ok('triggeredBy=bob', run.data?.triggeredBy === 'bob', `=${run.data?.triggeredBy}`)
  ok('carol 실행 403', (await C('POST', `/flows/${flowId}/runs`, {})).status === 403)

  console.log('== ⑤ 테넌트 격리 (team-b 의 dave) ==')
  const daveFlows = await D('GET', '/flows')
  ok('dave 목록에 team-a 플로우 없음', daveFlows.status === 200 && !daveFlows.data?.some((f) => f.id === flowId))
  ok('dave GET team-a 플로우 404', (await D('GET', `/flows/${flowId}`)).status === 404)
  ok('dave GET team-a 실행목록 404 (구멍 수정)', (await D('GET', `/flows/${flowId}/runs?limit=5`)).status === 404)
  ok('carol(같은 팀) GET 실행목록 200', (await C('GET', `/flows/${flowId}/runs?limit=5`)).status === 200)

  console.log('== ⑥ 플러그인 platform-admin 게이트 ==')
  const fd = new FormData()
  fd.append('file', new Blob([Buffer.from('junk')], { type: 'application/java-archive' }), 'x.jar')
  const upBob = await fetch(`${BASE}/api/v1/plugins`, { method: 'POST', headers: { Authorization: `Bearer ${bob}` }, body: fd })
  ok('bob(editor) 업로드 403', upBob.status === 403, `=${upBob.status}`)
  const fd2 = new FormData()
  fd2.append('file', new Blob([Buffer.from('junk')], { type: 'application/java-archive' }), 'x.jar')
  const upAlice = await fetch(`${BASE}/api/v1/plugins`, { method: 'POST', headers: { Authorization: `Bearer ${alice}` }, body: fd2 })
  ok('alice(platform-admin) 는 403 아님(깨진 JAR 4xx/5xx 허용)', upAlice.status !== 403, `=${upAlice.status}`)

  console.log('== ⑦ mock slug 팀 스코프 ==')
  const mkB = await B('POST', '/mock-servers', { name: 'demo', slug: 'demo' })
  ok('bob(team-a) slug demo 생성', mkB.status === 201, `=${mkB.status} ${JSON.stringify(mkB.data)}`)
  const mkD = await D('POST', '/mock-servers', { name: 'demo', slug: 'demo' })
  ok('dave(team-b) 같은 slug 생성 성공(팀 스코프)', mkD.status === 201, `=${mkD.status}`)
  const mkB2 = await B('POST', '/mock-servers', { name: 'demo2', slug: 'demo' })
  ok('bob 같은 팀 중복 slug 400', mkB2.status === 400)
  const servA = await fetch(`${BASE}/mock/team-a/demo/__routes`)
  ok('/mock/team-a/demo 서빙', servA.status === 200)
  const servB = await fetch(`${BASE}/mock/team-b/demo/__routes`)
  ok('/mock/team-b/demo 서빙', servB.status === 200)
  ok('dave 가 bob mock 관리 404', (await D('GET', `/mock-servers/${mkB.data?.id}`)).status === 404)

  console.log('== ⑧ admin 설정 저장 ==')
  ok('alice PUT /settings/relay 200', (await A('PUT', '/settings/relay', { value: 'http://team-a.example.com' })).status === 200)
  ok('bob(editor) PUT /settings/relay 403', (await B('PUT', '/settings/relay', { value: 'x' })).status === 403)

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('e2e 실패:', e); process.exit(1) })
