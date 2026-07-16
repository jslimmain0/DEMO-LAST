#!/usr/bin/env node
/**
 * SaaS P3 e2e — presence 릴레이(dev 모드) 검증.
 * 전제: 백엔드가 dev(H2) 모드로 :18080 실행 중. Node 24+(내장 WebSocket).
 * 실행: node e2e/saas-p3-presence.mjs
 */
const BASE = process.env.FLOWLINK_BASE || 'http://localhost:18080'
const WS = BASE.replace(/^http/, 'ws')

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
  return r.json().catch(() => null)
}

/** 수신 메시지를 쌓아두고 조건 대기하는 WebSocket 래퍼. */
function connect(flowId, name) {
  const ws = new WebSocket(`${WS}/ws/presence?flowId=${flowId}&name=${encodeURIComponent(name)}`)
  const inbox = []
  ws.onmessage = (ev) => inbox.push(JSON.parse(ev.data))
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  async function waitFor(pred, timeoutMs = 5000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = inbox.find(pred)
      if (hit) return hit
      await sleep(50)
    }
    return null
  }
  return { ws, inbox, opened, waitFor, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() }
}

async function main() {
  const flow = await api('POST', '/flows', { name: 'p3-presence' })
  const flow2 = await api('POST', '/flows', { name: 'p3-presence-2' })

  console.log('== ① 입장/스냅샷/브로드캐스트 ==')
  const a = connect(flow.id, '앨리스'); await a.opened
  const helloA = await a.waitFor((m) => m.t === 'hello')
  ok('A hello(빈 방)', helloA && helloA.peers.length === 0, JSON.stringify(helloA))
  const b = connect(flow.id, '밥'); await b.opened
  const helloB = await b.waitFor((m) => m.t === 'hello')
  ok('B hello 에 A 스냅샷', helloB?.peers?.length === 1 && helloB.peers[0].name === '앨리스')
  const joinAtA = await a.waitFor((m) => m.t === 'join')
  ok('A 가 B join 수신(색 배정)', joinAtA?.peer?.name === '밥' && !!joinAtA?.peer?.color)

  console.log('== ② 커서/편집중/저장 중계 ==')
  b.send({ t: 'cursor', x: 100.5, y: 200 })
  const cur = await a.waitFor((m) => m.t === 'cursor')
  ok('커서 중계(+id)', cur?.x === 100.5 && cur?.id === helloB.id)
  ok('본인에겐 미중계', !b.inbox.some((m) => m.t === 'cursor'))
  b.send({ t: 'editing', nodeId: 'n1' })
  const ed = await a.waitFor((m) => m.t === 'editing')
  ok('편집중 중계', ed?.nodeId === 'n1')
  b.send({ t: 'saved' })
  const sv = await a.waitFor((m) => m.t === 'saved')
  ok('저장 알림(이름 포함)', sv?.name === '밥')

  console.log('== ③ 늦은 입장자 스냅샷 + 방 격리 + 퇴장 ==')
  const c = connect(flow.id, '캐럴'); await c.opened
  const helloC = await c.waitFor((m) => m.t === 'hello')
  const bobSnap = helloC?.peers?.find((p) => p.name === '밥')
  ok('늦은 입장자에 밥의 최근 상태', bobSnap?.cursor?.x === 100.5 && bobSnap?.editing === 'n1', JSON.stringify(bobSnap))
  const x = connect(flow2.id, '외부인'); await x.opened
  await x.waitFor((m) => m.t === 'hello')
  x.send({ t: 'cursor', x: 1, y: 1 })
  await sleep(400)
  ok('다른 flow 이벤트 격리', !a.inbox.some((m) => m.t === 'join' && m.peer?.name === '외부인'))
  b.close()
  const lv = await a.waitFor((m) => m.t === 'leave')
  ok('퇴장 브로드캐스트', lv?.id === helloB.id)

  console.log('== ④ 핸드셰이크 검증 ==')
  const bad = new WebSocket(`${WS}/ws/presence?flowId=not-a-uuid`)
  const badResult = await new Promise((res) => { bad.onerror = () => res('err'); bad.onopen = () => res('open') })
  ok('비 UUID flowId 거절', badResult === 'err')

  a.close(); c.close(); x.close()
  console.log(`\n결과: ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('e2e 실패:', e); process.exit(1) })
