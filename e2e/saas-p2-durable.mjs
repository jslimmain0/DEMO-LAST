#!/usr/bin/env node
/**
 * SaaS P2 e2e — 비동기 실행 + suspension DB 내구성(재시작 생존) 검증.
 *
 * 전제: 백엔드가 dev(H2) 모드로 :18080 에서 실행 중, P2 jar(비동기)로 빌드됨.
 * 이 스크립트가 중간에 백엔드를 재시작한다(scripts/stop.ps1·start.ps1).
 * 실행: node e2e/saas-p2-durable.mjs
 */
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = process.env.FLOWLINK_BASE || 'http://localhost:18080'
const BACKEND_DIR = fileURLToPath(new URL('../backend', import.meta.url))

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await r.json() } catch { /* no body */ }
  return { status: r.status, data }
}

async function createFlow(name, graph) {
  const f = (await api('POST', '/flows', { name })).data
  await api('POST', `/flows/${f.id}/versions`, { graph })
  return f.id
}

async function pollExec(execId, until, timeoutMs = 30000, intervalMs = 300) {
  const t0 = Date.now()
  let d = null
  while (Date.now() - t0 < timeoutMs) {
    d = (await api('GET', `/executions/${execId}`)).data
    if (d && until(d)) return d
    await sleep(intervalMs)
  }
  return d
}

const TERMINAL = (d) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(d.status)

function ps(script, args = '') {
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File scripts\\${script} ${args}`, { cwd: BACKEND_DIR, stdio: 'pipe' })
  } catch (e) {
    console.error(`  ⚠ ${script} ${args} 실패(exit=${e.status}):`, e.stderr?.toString?.().slice(-500) ?? e.message)
    throw e
  }
}

async function waitHealth(timeoutMs = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/actuator/health`)
      if (r.ok) return true
    } catch { /* not up yet */ }
    await sleep(2000)
  }
  return false
}

async function restartBackend() {
  console.log('  … 백엔드 재시작 중')
  ps('stop.ps1', '-KeepDb')
  await sleep(1500)
  ps('start.ps1', '-H2 -NoDb')
  const up = await waitHealth()
  if (!up) throw new Error('재시작 후 헬스 체크 실패')
  await sleep(1500) // recoverOnStartup 여유
}

const MOCK_SLUG = 'p2mock'

async function ensureMock() {
  const list = (await api('GET', '/mock-servers')).data ?? []
  let m = list.find((s) => s.slug === MOCK_SLUG)
  if (!m) m = (await api('POST', '/mock-servers', { name: 'P2 e2e', slug: MOCK_SLUG })).data
  const spec = {
    routes: [
      { id: 'r1', method: 'GET', path: '/slow', rules: [{ id: 'u1', status: 200, contentType: 'text', body: 'ok', delayMs: 3000 }] },
      { id: 'r2', method: 'GET', path: '/veryslow', rules: [{ id: 'u2', status: 200, contentType: 'text', body: 'ok', delayMs: 10000 }] },
    ],
  }
  await api('PUT', `/mock-servers/${m.id}/spec`, { spec })
  await api('PATCH', `/mock-servers/${m.id}`, { enabled: true })
  return m
}

const httpNode = (id, path) => ({
  id, name: 'HTTP', type: 'http', cat: 'generic', method: 'GET',
  baseUrl: `${BASE}/mock/${MOCK_SLUG}`, path, respType: 'text', reqMode: 'server',
})
const G = (nodes, edges) => ({ name: 'g', nodes, edges })
const N = (id, type, extra = {}) => ({ id, name: type, type, ...extra })
const E = (from, to) => ({ from, to })

async function main() {
  await ensureMock()

  console.log('== ① 비동기 즉시 반환 (3초 지연 HTTP) ==')
  {
    const flowId = await createFlow('p2-async', G(
      [N('s1', 'start'), httpNode('h1', '/slow'), N('e1', 'end')],
      [E('s1', 'h1'), E('h1', 'e1')]))
    const t0 = Date.now()
    const run = await api('POST', `/flows/${flowId}/runs`, {})
    const elapsed = Date.now() - t0
    ok('POST 1.5초 내 반환', elapsed < 1500, `${elapsed}ms`)
    ok('상태 RUNNING', run.data?.status === 'RUNNING', run.data?.status)
    const done = await pollExec(run.data.id, TERMINAL, 30000)
    ok('폴링으로 SUCCEEDED', done?.status === 'SUCCEEDED', done?.status)
    ok('노드 기록 존재', (done?.nodes?.length ?? 0) >= 3)
  }

  console.log('== ② wait 콜백 자동 재개 ==')
  {
    const flowId = await createFlow('p2-wait', G(
      [N('s1', 'start'), N('w1', 'wait', { waitTimeoutSec: 120 }), N('a1', 'assert', { condition: "{{ code@w1 }} == '0000'" }), N('e1', 'end')],
      [E('s1', 'w1'), E('w1', 'a1'), E('a1', 'e1')]))
    const run = await api('POST', `/flows/${flowId}/runs`, {})
    const waiting = await pollExec(run.data.id, (d) => !!d.pendingWait, 20000)
    ok('pendingWait + receiveUrl', !!waiting?.pendingWait?.receiveUrl, JSON.stringify(waiting?.pendingWait))
    const cb = await fetch(`${BASE}/relay/${run.data.id}/cb/w1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"0000"}',
    })
    ok('콜백 ACK OK(즉시)', cb.ok)
    const done = await pollExec(run.data.id, TERMINAL, 20000)
    ok('콜백 후 SUCCEEDED(assert 통과)', done?.status === 'SUCCEEDED', done?.status)
  }

  console.log('== ③ 재시작 내구성 — wait 진입 → 재시작 → 콜백 → 완주 (+숫자 라운드트립) ==')
  let restartFlowExecId
  {
    const flowId = await createFlow('p2-durable', G(
      [N('s1', 'start'), N('w1', 'wait', { waitTimeoutSec: 300 }), N('a1', 'assert', { condition: '{{ amount@input }} == 1500' }), N('e1', 'end')],
      [E('s1', 'w1'), E('w1', 'a1'), E('a1', 'e1')]))
    const run = await api('POST', `/flows/${flowId}/runs`, { input: { amount: 1500 } })
    restartFlowExecId = run.data.id
    const waiting = await pollExec(run.data.id, (d) => !!d.pendingWait, 20000)
    ok('재시작 전 pendingWait', !!waiting?.pendingWait)

    await restartBackend()

    const after = (await api('GET', `/executions/${run.data.id}`)).data
    ok('재시작 후 WAITING 유지', after?.status === 'WAITING', after?.status)
    ok('재시작 후 pendingWait 반환(DB outcome)', !!after?.pendingWait, JSON.stringify(after))
    const cb = await fetch(`${BASE}/relay/${run.data.id}/cb/w1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ok":"y"}',
    })
    ok('재시작 후 콜백 수신', cb.ok)
    const done = await pollExec(run.data.id, TERMINAL, 20000)
    ok('rehydrate 재개 → SUCCEEDED', done?.status === 'SUCCEEDED', done?.status ?? '' + (done?.error ?? ''))
    ok('숫자 비교 assert 통과(스냅샷 라운드트립)', !done?.nodes?.some((n) => n.status === 'FAILED'))
  }

  console.log('== ④ 재시작 후 타임아웃 재무장 ==')
  {
    const flowId = await createFlow('p2-timeout', G(
      [N('s1', 'start'), N('w1', 'wait', { waitTimeoutSec: 8 }), N('e1', 'end')],
      [E('s1', 'w1'), E('w1', 'e1')]))
    const run = await api('POST', `/flows/${flowId}/runs`, {})
    await pollExec(run.data.id, (d) => !!d.pendingWait, 20000)
    await restartBackend() // 재시작 동안 데드라인 경과 → 복구 시 즉시 발화
    const done = await pollExec(run.data.id, TERMINAL, 30000)
    ok('재무장 타임아웃 → FAILED', done?.status === 'FAILED', done?.status)
    ok('타임아웃 사유', (done?.error ?? '').includes('타임아웃'), done?.error)
  }

  console.log('== ⑤ RUNNING 고아 reconcile ==')
  {
    const flowId = await createFlow('p2-orphan', G(
      [N('s1', 'start'), httpNode('h1', '/veryslow'), N('e1', 'end')],
      [E('s1', 'h1'), E('h1', 'e1')]))
    const run = await api('POST', `/flows/${flowId}/runs`, {})
    await sleep(1500)
    const mid = (await api('GET', `/executions/${run.data.id}`)).data
    ok('킬 직전 RUNNING', mid?.status === 'RUNNING', mid?.status)
    await restartBackend() // 강제 종료 → 워커 소실
    const done = (await api('GET', `/executions/${run.data.id}`)).data
    ok('고아 → FAILED(재시작 사유)', done?.status === 'FAILED' && (done?.error ?? '').includes('재시작'), `${done?.status} ${done?.error}`)
  }

  console.log('== ⑥ resume 멱등 + ⑦ input 재개 + ⑧ ⏹ 취소 ==')
  {
    const flowId = await createFlow('p2-input', G(
      [N('s1', 'start'), N('i1', 'input', { waitMsg: 'OTP?', waitFields: [{ key: 'otp', label: 'OTP', type: 'string' }] }), N('a1', 'assert', { condition: "{{ otp@i1 }} == '777'" }), N('e1', 'end')],
      [E('s1', 'i1'), E('i1', 'a1'), E('a1', 'e1')]))
    const run = await api('POST', `/flows/${flowId}/runs`, {})
    const waiting = await pollExec(run.data.id, (d) => !!d.pendingInput, 20000)
    ok('pendingInput', !!waiting?.pendingInput)
    const r1 = await api('POST', `/executions/${run.data.id}/resume`, { nodeId: 'i1', formValues: { otp: '777' } })
    ok('resume 즉시 응답', r1.status === 200)
    const done = await pollExec(run.data.id, TERMINAL, 20000)
    ok('input 재개 → SUCCEEDED', done?.status === 'SUCCEEDED', done?.status)
    const idem = await api('POST', `/executions/${run.data.id}/resume`, { nodeId: 'i1', formValues: { otp: 'x' } })
    ok('완료 후 resume 멱등(200, 상태 유지)', idem.status === 200 && idem.data?.status === 'SUCCEEDED')

    const flowId2 = await createFlow('p2-cancel', G(
      [N('s1', 'start'), N('w1', 'wait', { waitTimeoutSec: 120 }), N('e1', 'end')],
      [E('s1', 'w1'), E('w1', 'e1')]))
    const run2 = await api('POST', `/flows/${flowId2}/runs`, {})
    await pollExec(run2.data.id, (d) => !!d.pendingWait, 20000)
    await api('POST', `/executions/${run2.data.id}/resume`, { nodeId: 'w1', error: '실행이 중단되었습니다.', aborted: true })
    const done2 = await pollExec(run2.data.id, TERMINAL, 20000)
    ok('⏹ → CANCELLED', done2?.status === 'CANCELLED', done2?.status)
  }

  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('e2e 실패:', e); process.exit(1) })
