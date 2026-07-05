#!/usr/bin/env node
/**
 * demos 워크플로가 때릴 가짜 대상 시스템을 FlowLink **내장 Mock 서버 기능**으로 세운다.
 * 폐기된 리포 루트 `mock-server.js`(:9090) 를 대체한다 — 별도 프로세스 없이 백엔드(:18080) 안에서 서빙.
 *
 * 실행:  node demos/seed-mock.mjs            (백엔드가 :18080 에서 떠 있어야 함)
 *        FLOWLINK_BASE=http://host:port node demos/seed-mock.mjs   (백엔드 주소 override)
 *
 * 동작(upsert): slug `demo` 의 mock 서버가 없으면 생성, 있으면 spec 만 갱신 → 항상 최신 라우트로 맞춘다.
 * 의존성 0 (Node 18+ 전역 fetch). 백엔드가 준비될 때까지 헬스를 잠깐 폴링한다.
 *
 * 서빙 base URL:  http://localhost:18080/mock/demo
 *   데모 JSON 의 baseUrl / formAction 이 이 주소를 가리킨다.
 *
 * 무상태 근사(원본 mock-server.js 는 주문/결제 기록을 메모리에 들고 있었다):
 *   - 주문 total/productName/qty 는 데모 고정값(p-200·2개)으로 하드코딩(상태 없음).
 *   - tid/orderId 는 `{{seq}}`(서버별 증가 카운터)로 근사.
 *   - 결제창은 2단계(/checkout→/approve→returnUrl)를 1단계로 접어, 결제창 HTML 이 곧바로
 *     returnUrl 로 결과(resultCode 등)를 POST 한다(pay-mock 데모와 동일 패턴).
 *   - TCP 전문(demo-05)·/openapi.json 은 내장 Mock 범위 밖 → 재현하지 않음(demo-05 는 이미 삭제됨).
 */
'use strict'

const BASE = (process.env.FLOWLINK_BASE || 'http://localhost:18080').replace(/\/$/, '')
const SLUG = 'demo'
const NAME = 'demos 통합 mock (mock-server.js 대체)'

// ---------- 결제창 HTML (form 노드 팝업이 여는 페이지 — 버튼이 returnUrl 로 결과 POST) ----------
const CHECKOUT_HTML = `<!doctype html><meta charset="utf-8"><title>MockPay 결제창</title>
<body style="font-family:'Segoe UI',sans-serif;background:#f3f4f8;text-align:center;padding-top:40px;margin:0;color:#1f2430">
<div style="max-width:380px;margin:0 auto;background:#fff;border-radius:14px;padding:26px;box-shadow:0 8px 30px rgba(30,40,80,.12)">
<h2 style="margin:0 0 6px;color:#2a3fd4">MockPay 안전결제</h2>
<p style="color:#5a6072;font-size:14px">주문 {{body.orderId}} · <b>{{body.amount}}원</b></p>
<form method="POST" action="{{body.returnUrl}}">
<input type="hidden" name="resultCode" value="0000">
<input type="hidden" name="resultMsg" value="정상승인">
<input type="hidden" name="tid" value="PAYMOCK-{{seq}}">
<input type="hidden" name="orderId" value="{{body.orderId}}">
<input type="hidden" name="amount" value="{{body.amount}}">
<button style="width:100%;padding:13px;margin-top:10px;border:0;border-radius:9px;background:#2a3fd4;color:#fff;font-size:15px;font-weight:700;cursor:pointer">결제 승인</button>
</form>
<form method="POST" action="{{body.returnUrl}}">
<input type="hidden" name="resultCode" value="9999">
<input type="hidden" name="resultMsg" value="사용자거절">
<input type="hidden" name="orderId" value="{{body.orderId}}">
<button style="width:100%;padding:11px;margin-top:8px;border:0;border-radius:9px;background:#eef0f5;color:#5a6072;font-size:14px;cursor:pointer">거절</button>
</form>
<p style="color:#9aa1b2;font-size:11px;margin-top:14px">모의 결제창입니다 — 버튼을 누르면 결과가 가맹점(returnUrl)으로 전송됩니다.</p>
</div></body>`

// ---------- mock spec (라우트 목록) ----------
const SPEC = {
  routes: [
    // ── 가짜 결제 게이트웨이 ─────────────────────────────────────────────
    {
      id: 'r-checkout', method: 'POST', path: '/pay/checkout',
      rules: [{ id: 'u1', status: 200, contentType: 'html', body: CHECKOUT_HTML }],
    },
    {
      // 승인 후 tid 조회(무상태 — 항상 정상승인으로 응답). demo-01 IF true 분기가 호출.
      id: 'r-status', method: 'GET', path: '/pay/status',
      rules: [{
        id: 'u1', status: 200, contentType: 'json',
        body: '{"status":"APPROVED","resultMsg":"정상승인","tid":"{{query.tid}}","approvedAt":"{{now}}"}',
      }],
    },

    // ── REST API ────────────────────────────────────────────────────────
    {
      id: 'r-login', method: 'POST', path: '/api/login',
      rules: [
        // password=wrong 이면 401 (원본 mock 재현)
        { id: 'u1', when: [{ source: 'body', key: 'password', op: 'eq', value: 'wrong' }],
          status: 401, contentType: 'json', body: '{"error":"비밀번호가 올바르지 않습니다"}' },
        // 그 외 로그인 성공 — token 은 tok- 접두(주문 API 의 Bearer 검사와 맞물림)
        { id: 'u2', status: 200, contentType: 'json',
          body: '{"token":"tok-{{uuid}}","userId":"u-1001","name":"김철수"}' },
      ],
    },
    {
      id: 'r-otp-send', method: 'POST', path: '/api/otp/send',
      rules: [{ id: 'u1', status: 200, contentType: 'json',
        body: '{"sent":true,"expiresIn":180,"hint":"모의 OTP는 111111"}' }],
    },
    {
      id: 'r-otp-verify', method: 'POST', path: '/api/otp/verify',
      rules: [
        { id: 'u1', when: [{ source: 'body', key: 'otp', op: 'eq', value: '111111' }],
          status: 200, contentType: 'json', body: '{"verified":true}' },
        { id: 'u2', status: 200, contentType: 'json', body: '{"verified":false}' },
      ],
    },
    {
      // Bearer tok-* 필수 → 주문 생성(무상태: total/productName 은 데모 고정값 p-200·2개로 근사)
      id: 'r-orders-create', method: 'POST', path: '/api/orders',
      rules: [
        { id: 'u1',
          when: [{ source: 'header', key: 'authorization', op: 'contains', value: 'Bearer tok-' }],
          status: 200, contentType: 'json',
          body: '{"orderId":"ord-{{seq}}","status":"CREATED","productId":"p-200","productName":"프리미엄 요금제","qty":2,"total":96000}' },
        { id: 'u2', status: 401, contentType: 'json',
          body: '{"error":"인증 필요 — Authorization: Bearer {token}"}' },
      ],
    },
    {
      // 주문 조회(무상태: path 의 orderId 만 echo, 나머지는 데모 고정값)
      id: 'r-orders-get', method: 'GET', path: '/api/orders/{orderId}',
      rules: [{ id: 'u1', status: 200, contentType: 'json',
        body: '{"orderId":"{{path.orderId}}","status":"CREATED","productId":"p-200","productName":"프리미엄 요금제","qty":2,"total":96000}' }],
    },
    {
      // 클라이언트 모드(demo-06) 에코 — 브라우저가 직접 호출
      id: 'r-echo', method: 'ANY', path: '/api/echo',
      rules: [{ id: 'u1', status: 200, contentType: 'json',
        body: '{"method":"{{method}}","path":"/api/echo","query":{"from":"{{query.from}}"}}' }],
    },

    // ── 레거시 EUC-KR ───────────────────────────────────────────────────
    {
      // 잔액조회 — EUC-KR urlencoded 응답(custName=홍길동 이 EUC-KR 바이트로 나감)
      id: 'r-legacy-inquiry', method: 'POST', path: '/legacy/inquiry',
      rules: [{ id: 'u1', status: 200, contentType: 'urlencoded', charset: 'EUC-KR',
        body: 'resultCode=00&acctNo={{body.acctNo}}&custName=홍길동&balance=1234500&asOf=20260704' }],
    },
    {
      // 고객정보 — EUC-KR XML
      id: 'r-legacy-xml', method: 'GET', path: '/legacy/user.xml',
      rules: [{ id: 'u1', status: 200, contentType: 'xml', charset: 'EUC-KR',
        body: '<?xml version="1.0" encoding="EUC-KR"?><user><name>홍길동</name><grade>VIP</grade><point>1200</point></user>' }],
    },
  ],
}

// ---------- HTTP 헬퍼 ----------
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 비 JSON */ }
  return { status: res.status, json, text }
}

async function probeRoutes() {
  try {
    const res = await fetch(`${BASE}/mock/${SLUG}/__routes`)
    const j = await res.json()
    return j && Array.isArray(j.routes) ? j.routes.length : 0
  } catch {
    return 0
  }
}

async function waitForBackend() {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const res = await fetch(BASE + '/actuator/health', { method: 'GET' })
      if (res.ok) return
    } catch { /* 아직 안 뜸 */ }
    if (Date.now() > deadline) {
      throw new Error(`백엔드(${BASE})가 30초 내 응답하지 않습니다. 먼저 백엔드를 띄우세요.`)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function main() {
  console.log(`[seed] 백엔드 대기: ${BASE}`)
  await waitForBackend()

  // 1) upsert — slug 로 기존 서버 조회
  const list = await api('GET', '/api/v1/mock-servers')
  if (list.status !== 200 || !Array.isArray(list.json)) {
    throw new Error(`mock 서버 목록 조회 실패 (${list.status}): ${list.text}`)
  }
  let server = list.json.find((s) => s.slug === SLUG)

  if (!server) {
    const created = await api('POST', '/api/v1/mock-servers', { name: NAME, slug: SLUG })
    if (created.status !== 201) {
      throw new Error(`mock 서버 생성 실패 (${created.status}): ${created.text}`)
    }
    server = created.json
    console.log(`[seed] 생성: slug=${SLUG} id=${server.id}`)
  } else {
    console.log(`[seed] 기존 서버 갱신: slug=${SLUG} id=${server.id}`)
    // 비활성 상태였을 수 있으니 활성화 보장
    await api('PATCH', `/api/v1/mock-servers/${server.id}`, { enabled: true })
  }

  // 2) spec 갱신 — PUT /spec 의 본문 형태는 백엔드 버전에 따라 다르다:
  //    문서/구(舊) 계약: { spec: {routes:[...]} }  ·  현 코틀린 빌드: {routes:[...]} 직접.
  //    둘 다 시도하고 __routes 로 실제 반영을 확인해 맞는 형태를 채택한다(양쪽 빌드 호환).
  const want = SPEC.routes.length
  const shapes = [SPEC, { spec: SPEC }] // 직접형 우선, 실패 시 래핑형
  let routeCount = 0
  let lastErr = ''
  for (const payload of shapes) {
    const put = await api('PUT', `/api/v1/mock-servers/${server.id}/spec`, payload)
    if (put.status !== 200) { lastErr = `PUT ${put.status}: ${put.text}`; continue }
    routeCount = await probeRoutes()
    if (routeCount === want) break
  }
  if (routeCount !== want) {
    throw new Error(`spec 반영 실패 — 서빙 라우트 ${routeCount}/${want}. ${lastErr}`)
  }

  console.log('')
  console.log(`[seed] ✅ 완료 — mock base URL: ${BASE}/mock/${SLUG}`)
  console.log(`[seed]    라우트 ${routeCount}개 서빙 중 (예: POST ${BASE}/mock/${SLUG}/api/login)`)
  console.log('')
}

main().catch((e) => {
  console.error(`[seed] ❌ ${e.message}`)
  process.exit(1)
})
