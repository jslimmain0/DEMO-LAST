#!/usr/bin/env node
/**
 * FlowLink mock — 데모 워크플로가 때릴 가짜 대상 시스템 모음.
 * 단일 파일 · node:http + node:net · 의존성 0.
 * 실행: `node mock-server.js [httpPort] [tcpPort]` (기본 HTTP 9090, TCP 9091)
 *
 * 담고 있는 가짜 시스템 (설계: docs/superpowers/specs/2026-07-04-mock-demo-suite-design.md)
 *   가짜 결제 게이트웨이(PG)
 *     POST/GET /pay/checkout   결제창 HTML(승인/거절 버튼) — form 노드 팝업이 여는 페이지
 *     POST /pay/approve        버튼 제출 → tid 발급·기록 → notiUrl 노티 → returnUrl 로 자동 POST 브리지
 *     GET  /pay/status?tid=    승인 트랜잭션 조회(JSON)
 *   REST API
 *     POST /api/login          {username,password} → {token,userId,name} (password=wrong 이면 401)
 *     POST /api/otp/send       → {sent:true, hint:"모의 OTP는 111111"}
 *     POST /api/otp/verify     {otp} → {verified:true|false}
 *     GET  /api/products       상품 배열
 *     POST /api/orders         Bearer tok-* 필수 → 201 주문 생성
 *     GET  /api/orders/{id}    주문 조회
 *     ANY  /api/echo           {method,path,query,headers,body} 에코
 *     GET  /api/slow?ms=       지연 응답(기본 3000, 최대 30000)
 *   레거시 EUC-KR
 *     POST /legacy/inquiry     urlencoded(EUC-KR) 잔액조회 → EUC-KR urlencoded 응답
 *     GET  /legacy/user.xml    EUC-KR XML 사용자 조회
 *   기타
 *     GET  /openapi.json       /api 를 기술한 OpenAPI 3 스펙([API] 임포트 데모용)
 *     GET  /health             {ok, orders, payments}
 *     GET  /                   엔드포인트 안내 페이지
 *   TCP :9091                  고정길이 금융 전문 — 4자리 길이 프리픽스(자기 미포함) +
 *                              txCode(4)+acctNo(12). BAL1 → 00+잔액(12)+고객명(10, EUC-KR)
 *
 * 상태는 전부 메모리(주문/결제 기록) — 재시작하면 소멸. 모든 HTTP 응답 CORS 오픈(클라이언트 모드용).
 */
'use strict'

const http = require('node:http')
const https = require('node:https')
const net = require('node:net')

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 9090)
const TCP_PORT = Number(process.argv[3] || process.env.MOCK_TCP_PORT || 9091)
const MAX_BODY = 1024 * 1024

// EUC-KR 은 Node 내장으로 "인코딩"이 불가(TextEncoder 는 UTF-8 전용) →
// 데모 고정 문자열의 EUC-KR 바이트를 하드코딩한다. (.NET Encoding.GetEncoding(51949) 로 생성)
const KR = {
  홍길동: Buffer.from([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf]),
}
// EUC-KR "디코딩"은 Node full-icu 의 TextDecoder 로 가능. (없으면 latin1 폴백 — 한글은 깨지지만 ASCII 필드는 동작)
let eucKrDecoder = null
try { eucKrDecoder = new TextDecoder('euc-kr') } catch { /* ICU 미탑재 빌드 */ }

/** 주문·결제 인메모리 저장소 */
const orders = new Map() // orderId → 주문
const payments = new Map() // tid → 결제 트랜잭션
let orderSeq = 1000

const PRODUCTS = [
  { id: 'p-100', name: '베이직 요금제', price: 19000 },
  { id: 'p-200', name: '프리미엄 요금제', price: 48000 },
  { id: 'p-300', name: '엔터프라이즈 요금제', price: 120000 },
]

// ---------- 공통 유틸 ----------

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
}

function readBodyBytes(req, cb) {
  const chunks = []
  let size = 0
  let done = false
  req.on('data', (c) => {
    size += c.length
    if (size > MAX_BODY) {
      if (!done) { done = true; cb(null) }
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => { if (!done) { done = true; cb(Buffer.concat(chunks)) } })
  req.on('error', () => { if (!done) { done = true; cb(null) } })
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** percent-encoded 문자열 → 바이트 (+ 는 공백). 리터럴 문자는 literalEnc(utf8|latin1)로 바이트화. */
function pctDecodeBytes(s, literalEnc) {
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '+') { out.push(0x20); continue }
    if (c === '%' && i + 2 < s.length && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }
    const b = Buffer.from(c, literalEnc || 'utf8')
    for (const x of b) out.push(x)
  }
  return Buffer.from(out)
}

/** urlencoded 원문(a=1&b=2)을 키-값으로. 값 바이트는 decoder(기본 UTF-8)로 디코딩. */
function parseUrlEncoded(text, decoder, literalEnc) {
  const dec = decoder || { decode: (b) => b.toString('utf8') }
  const out = {}
  for (const pair of String(text || '').split('&')) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    const k = dec.decode(pctDecodeBytes(eq >= 0 ? pair.slice(0, eq) : pair, literalEnc))
    const v = eq >= 0 ? dec.decode(pctDecodeBytes(pair.slice(eq + 1), literalEnc)) : ''
    out[k] = v
  }
  return out
}

/** JSON 우선, 실패 시 urlencoded 로 요청 본문 파싱(둘 다 UTF-8). */
function parseBody(bytes, contentType) {
  const text = bytes.toString('utf8')
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('json')) {
    try { return JSON.parse(text || '{}') } catch { return {} }
  }
  if (ct.includes('urlencoded') || (!ct && text.includes('='))) return parseUrlEncoded(text)
  try { return JSON.parse(text || '{}') } catch { return parseUrlEncoded(text) }
}

// ---------- 가짜 결제 게이트웨이 ----------

const PG_STYLE = `
  body{font-family:'Segoe UI',sans-serif;background:#f3f4f8;margin:0;padding:24px;color:#1f2430}
  .card{max-width:400px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(30,40,80,.12);overflow:hidden}
  .head{background:#2a3fd4;color:#fff;padding:16px 22px;font-weight:700;font-size:15px}
  .head small{display:block;font-weight:400;opacity:.8;margin-top:2px;font-size:11.5px}
  .body{padding:22px}
  .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eef0f5;font-size:13.5px}
  .row b{font-variant-numeric:tabular-nums}
  .amt{font-size:20px;color:#2a3fd4}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}
  button{padding:13px 0;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer}
  .ok{background:#2a3fd4;color:#fff}.no{background:#eef0f5;color:#5a6072}
  .note{margin-top:14px;font-size:11.5px;color:#9aa1b2;text-align:center}
`

function hiddenInputs(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n      ')
}

/** 결제창 — form 노드 팝업이 여는 페이지. [승인]/[거절] 이 /pay/approve 로 제출된다. */
function checkoutPage(f) {
  const amount = Number(f.amount || 0)
  const common = {
    productName: f.productName || '(상품명 없음)',
    amount: String(amount || f.amount || ''),
    orderId: f.orderId || '',
    returnUrl: f.returnUrl || '',
    notiUrl: f.notiUrl || '',
  }
  return `<!doctype html><meta charset="utf-8"><title>MockPay 안전결제</title><style>${PG_STYLE}</style>
<div class="card">
  <div class="head">MockPay 안전결제<small>FlowLink 데모 상점</small></div>
  <div class="body">
    <div class="row"><span>상품명</span><b>${escapeHtml(common.productName)}</b></div>
    <div class="row"><span>주문번호</span><b>${escapeHtml(common.orderId || '-')}</b></div>
    <div class="row"><span>결제 금액</span><b class="amt">${amount ? amount.toLocaleString('ko-KR') + '원' : escapeHtml(String(f.amount || '-'))}</b></div>
    <div class="btns">
      <form method="POST" action="/pay/approve">${hiddenInputs({ ...common, decision: 'approve' })}<button class="ok" style="width:100%">결제 승인</button></form>
      <form method="POST" action="/pay/approve">${hiddenInputs({ ...common, decision: 'decline' })}<button class="no" style="width:100%">거절</button></form>
    </div>
    <div class="note">모의 결제창입니다 — 실제 결제가 아닙니다.<br>버튼을 누르면 returnUrl 로 결과가 전송됩니다.</div>
  </div>
</div>`
}

/** 승인/거절 처리 → returnUrl 로 결과를 자동 POST 하는 브리지 페이지(실 PG 의 merchant-return 패턴). */
function approve(f, res) {
  const ok = f.decision !== 'decline'
  const tid = 'MOCKTID-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 10000)
  const result = {
    resultCode: ok ? '0000' : '9999',
    resultMsg: ok ? '정상승인' : '사용자거절',
    tid,
    orderId: f.orderId || '',
    amount: f.amount || '',
    approvedAt: new Date().toISOString(),
  }
  payments.set(tid, { ...result, productName: f.productName || '', status: ok ? 'APPROVED' : 'DECLINED' })
  console.log(`[mock] PG ${ok ? '승인' : '거절'} tid=${tid} order=${f.orderId} amount=${f.amount}`)

  // 서버 노티(웹훅) — notiUrl 이 있으면 파이어&포겟 POST (실패는 로그만)
  if (f.notiUrl) {
    try {
      const u = new URL(f.notiUrl)
      const mod = u.protocol === 'https:' ? https : http
      const body = new URLSearchParams(result).toString()
      const nreq = mod.request(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (nres) => nres.resume())
      nreq.on('error', (e) => console.log(`[mock] notiUrl 전송 실패: ${e.message}`))
      nreq.end(body)
    } catch (e) {
      console.log(`[mock] notiUrl 파싱 실패: ${e.message}`)
    }
  }

  if (!f.returnUrl) {
    sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><style>${PG_STYLE}</style><div class="card"><div class="head">MockPay</div><div class="body">returnUrl 이 없어 결과를 전달할 수 없습니다.<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre></div></div>`)
    return
  }
  sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><title>결과 전송 중…</title><style>${PG_STYLE}</style>
<div class="card"><div class="head">MockPay</div><div class="body">결제 결과를 가맹점으로 전송하는 중…</div></div>
<form id="f" method="POST" action="${escapeHtml(f.returnUrl)}">
      ${hiddenInputs(result)}
</form>
<script>document.getElementById('f').submit()</script>`)
}

// ---------- 레거시 EUC-KR ----------

/** EUC-KR 잔액조회 응답 — 생 EUC-KR 바이트(percent-encoding 없음)로 응답하는 레거시 스타일. */
function legacyInquiry(reqBytes, res) {
  const decoder = eucKrDecoder || { decode: (b) => b.toString('latin1') }
  const f = parseUrlEncoded(reqBytes.toString('latin1'), decoder, 'latin1')
  const acctNo = String(f.acctNo || '').replace(/[^0-9A-Za-z-]/g, '')
  console.log(`[mock] legacy/inquiry acctNo=${acctNo}`)
  const body = Buffer.concat([
    Buffer.from(`resultCode=00&acctNo=${acctNo}&custName=`, 'ascii'),
    KR.홍길동,
    Buffer.from('&balance=1234500&asOf=20260704', 'ascii'),
  ])
  res.writeHead(200, { 'Content-Type': 'application/x-www-form-urlencoded; charset=EUC-KR', 'Content-Length': body.length })
  res.end(body)
}

function legacyUserXml(res) {
  const body = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="EUC-KR"?><user><name>', 'ascii'),
    KR.홍길동,
    Buffer.from('</name><grade>VIP</grade><point>1200</point></user>', 'ascii'),
  ])
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=EUC-KR', 'Content-Length': body.length })
  res.end(body)
}

// ---------- OpenAPI 스펙 ([API] 임포트 데모용) ----------

const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'FlowLink Mock API', version: '1.0.0', description: 'mock-server.js 의 /api 를 기술한 데모 스펙' },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/api/login': {
      post: {
        summary: '로그인', operationId: 'login',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } } } },
      },
    },
    '/api/otp/send': {
      post: {
        summary: 'OTP 발송', operationId: 'otpSend',
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { sent: { type: 'boolean' }, expiresIn: { type: 'integer' }, hint: { type: 'string' } } } } } } },
      },
    },
    '/api/otp/verify': {
      post: {
        summary: 'OTP 검증', operationId: 'otpVerify',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { otp: { type: 'string' } }, required: ['otp'] } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { verified: { type: 'boolean' } } } } } } },
      },
    },
    '/api/products': {
      get: {
        summary: '상품 목록', operationId: 'listProducts',
        responses: { 200: { $ref: '#/components/responses/ProductList' } },
      },
    },
    '/api/orders': {
      post: {
        summary: '주문 생성', operationId: 'createOrder',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateOrderRequest' } } } },
        responses: { 201: { description: '생성됨', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
    },
    '/api/orders/{orderId}': {
      get: {
        summary: '주문 조회', operationId: 'getOrder',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
    },
    '/api/slow': {
      get: {
        summary: '지연 응답', operationId: 'slow',
        parameters: [{ name: 'ms', in: 'query', schema: { type: 'integer', default: 3000 } }],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, sleptMs: { type: 'integer' } } } } } } },
      },
    },
  },
  components: {
    schemas: {
      LoginRequest: { type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } }, required: ['username', 'password'] },
      LoginResponse: { type: 'object', properties: { token: { type: 'string' }, userId: { type: 'string' }, name: { type: 'string' } } },
      Product: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' } } },
      CreateOrderRequest: { type: 'object', properties: { productId: { type: 'string' }, qty: { type: 'integer' }, memo: { type: 'string' } }, required: ['productId', 'qty'] },
      OrderBase: { type: 'object', properties: { orderId: { type: 'string' }, status: { type: 'string' } } },
      Order: {
        allOf: [
          { $ref: '#/components/schemas/OrderBase' },
          { type: 'object', properties: { productId: { type: 'string' }, productName: { type: 'string' }, qty: { type: 'integer' }, total: { type: 'number' } } },
        ],
      },
    },
    responses: {
      ProductList: { description: '상품 배열', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Product' } } } } },
    },
  },
}

// ---------- REST API ----------

function apiRoute(req, res, u, bodyBytes) {
  const parts = u.pathname.split('/').filter(Boolean) // ['api', ...]
  const body = parseBody(bodyBytes, req.headers['content-type'])

  if (req.method === 'POST' && u.pathname === '/api/login') {
    if (body.password === 'wrong') return sendJson(res, 401, { error: '비밀번호가 올바르지 않습니다' })
    return sendJson(res, 200, { token: 'tok-' + Math.random().toString(36).slice(2, 12), userId: 'u-1001', name: '김철수' })
  }
  if (req.method === 'POST' && u.pathname === '/api/otp/send') {
    return sendJson(res, 200, { sent: true, expiresIn: 180, hint: '모의 OTP는 111111' })
  }
  if (req.method === 'POST' && u.pathname === '/api/otp/verify') {
    return sendJson(res, 200, { verified: String(body.otp) === '111111' })
  }
  if (req.method === 'GET' && u.pathname === '/api/products') {
    return sendJson(res, 200, PRODUCTS)
  }
  if (req.method === 'POST' && u.pathname === '/api/orders') {
    const auth = String(req.headers.authorization || '')
    if (!auth.startsWith('Bearer tok-')) return sendJson(res, 401, { error: '인증 필요 — Authorization: Bearer {token}' })
    const product = PRODUCTS.find((p) => p.id === body.productId)
    if (!product) return sendJson(res, 400, { error: `알 수 없는 productId: ${body.productId}` })
    const qty = Number(body.qty) || 1
    const order = {
      orderId: 'ord-' + (++orderSeq),
      status: 'CREATED',
      productId: product.id,
      productName: product.name,
      qty,
      total: product.price * qty,
      memo: body.memo || '',
    }
    orders.set(order.orderId, order)
    console.log(`[mock] 주문 생성 ${order.orderId} ${product.name} x${qty}`)
    return sendJson(res, 201, order)
  }
  if (req.method === 'GET' && parts.length === 3 && parts[1] === 'orders') {
    const order = orders.get(parts[2])
    return order ? sendJson(res, 200, order) : sendJson(res, 404, { error: `주문 없음: ${parts[2]}` })
  }
  if (u.pathname === '/api/echo') {
    return sendJson(res, 200, {
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
      body: bodyBytes.toString('utf8'),
    })
  }
  if (req.method === 'GET' && u.pathname === '/api/slow') {
    const ms = Math.min(Math.max(Number(u.searchParams.get('ms')) || 3000, 0), 30000)
    setTimeout(() => sendJson(res, 200, { ok: true, sleptMs: ms }), ms)
    return
  }
  sendJson(res, 404, { error: `없는 API: ${req.method} ${u.pathname}` })
}

// ---------- 안내 페이지 ----------

function indexPage() {
  const row = (m, p, d) => `<tr><td><code>${m}</code></td><td><code>${p}</code></td><td>${d}</td></tr>`
  return `<!doctype html><meta charset="utf-8"><title>FlowLink Mock</title><style>
  body{font-family:'Segoe UI',sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#1f2430}
  h1{font-size:20px} h2{font-size:15px;margin-top:26px} table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{border:1px solid #e3e6ee;padding:6px 10px;text-align:left} code{background:#f3f4f8;padding:1px 5px;border-radius:4px}
  .muted{color:#8a92a6;font-size:12.5px}</style>
<h1>FlowLink Mock 대상 시스템 <span class="muted">HTTP :${PORT} · TCP :${TCP_PORT}</span></h1>
<p class="muted">데모 워크플로(demos/*.json)가 호출하는 가짜 시스템입니다. 상태는 메모리(재시작 시 소멸).</p>
<h2>가짜 결제 게이트웨이</h2>
<table>${row('POST/GET', '/pay/checkout', '결제창(승인/거절 버튼) — form 노드 팝업 대상. 필드: productName·amount·orderId·returnUrl·notiUrl?')}
${row('POST', '/pay/approve', '결과를 returnUrl 로 자동 POST (resultCode 0000/9999·tid·…)')}
${row('GET', '/pay/status?tid=', '승인 트랜잭션 조회')}</table>
<h2>REST API</h2>
<table>${row('POST', '/api/login', 'password=wrong 이면 401, 그 외 {token,…}')}
${row('POST', '/api/otp/send · /api/otp/verify', '모의 OTP = 111111')}
${row('GET', '/api/products', '상품 배열')}
${row('POST', '/api/orders', 'Bearer tok-* 필수 → 201')}
${row('GET', '/api/orders/{id}', '주문 조회')}
${row('ANY', '/api/echo', '요청 에코(클라이언트 모드 데모)')}
${row('GET', '/api/slow?ms=', '지연 응답')}</table>
<h2>레거시 EUC-KR · TCP · OpenAPI</h2>
<table>${row('POST', '/legacy/inquiry', 'EUC-KR urlencoded 잔액조회 (custName=홍길동)')}
${row('GET', '/legacy/user.xml', 'EUC-KR XML')}
${row('TCP', `:${TCP_PORT}`, '고정길이 전문 — 프리픽스4(미포함)+txCode(4)+acctNo(12), BAL1=잔액조회')}
${row('GET', '<a href="/openapi.json">/openapi.json</a>', 'OpenAPI 3 스펙 — 에디터 [API] 버튼에 붙여넣어 임포트')}</table>`
}

// ---------- HTTP 서버 ----------

const server = http.createServer((req, res) => {
  try {
    handle(req, res)
  } catch (e) {
    console.error('[mock] 요청 처리 오류:', e && e.message ? e.message : e)
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('mock error')
    } catch { /* 이미 응답 시작됨 */ }
  }
})

function handle(req, res) {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const u = new URL(req.url, `http://localhost:${PORT}`)
  console.log(`[mock] ${req.method} ${u.pathname}${u.search}`)

  // 본문이 필요 없는 GET 계열 먼저
  if (req.method === 'GET' && u.pathname === '/') return sendHtml(res, 200, indexPage())
  if (req.method === 'GET' && u.pathname === '/health') return sendJson(res, 200, { ok: true, orders: orders.size, payments: payments.size })
  if (req.method === 'GET' && u.pathname === '/openapi.json') return sendJson(res, 200, OPENAPI)
  if (req.method === 'GET' && u.pathname === '/legacy/user.xml') return legacyUserXml(res)
  if (req.method === 'GET' && u.pathname === '/pay/status') {
    const tid = u.searchParams.get('tid') || ''
    const tx = payments.get(tid)
    return tx ? sendJson(res, 200, tx) : sendJson(res, 404, { error: `트랜잭션 없음: ${tid}` })
  }
  if (req.method === 'GET' && u.pathname === '/pay/checkout') {
    return sendHtml(res, 200, checkoutPage(Object.fromEntries(u.searchParams)))
  }

  // 본문 수신 후 라우팅
  readBodyBytes(req, (bytes) => {
    try {
      if (bytes === null) {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('payload too large')
        return
      }
      if (req.method === 'POST' && u.pathname === '/pay/checkout') {
        return sendHtml(res, 200, checkoutPage(parseUrlEncoded(bytes.toString('utf8'))))
      }
      if (req.method === 'POST' && u.pathname === '/pay/approve') {
        return approve(parseUrlEncoded(bytes.toString('utf8')), res)
      }
      if (req.method === 'POST' && u.pathname === '/legacy/inquiry') {
        return legacyInquiry(bytes, res)
      }
      if (u.pathname.startsWith('/api/')) {
        return apiRoute(req, res, u, bytes)
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
    } catch (e) {
      console.error('[mock] 본문 처리 오류:', e && e.message ? e.message : e)
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('mock error')
      } catch { /* 이미 응답 시작됨 */ }
    }
  })
}

// ---------- TCP 고정길이 전문 서버 ----------
// TcpNodeExecutor 규약: 4바이트 ASCII 길이 프리픽스(자기 미포함) + 본문.
// 요청 본문 txCode(4)+acctNo(12) → BAL1 이면 resultCode(2)=00 + balance(12) + custName(10, EUC-KR).

const tcpServer = net.createServer((socket) => {
  let buf = Buffer.alloc(0)
  socket.setTimeout(10_000, () => socket.destroy())
  socket.on('error', () => { /* 상대 절단 — 무시 */ })
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = parseInt(buf.subarray(0, 4).toString('ascii'), 10)
      if (!Number.isFinite(len) || len < 0 || len > 9999) {
        console.log('[mock] TCP 잘못된 길이 프리픽스 — 연결 종료')
        socket.destroy()
        return
      }
      if (buf.length < 4 + len) break // 본문 대기
      const body = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      const txCode = body.subarray(0, 4).toString('ascii')
      const acctNo = body.subarray(4, 16).toString('ascii').trim()
      let resp
      if (txCode === 'BAL1') {
        resp = Buffer.concat([
          Buffer.from('00', 'ascii'),
          Buffer.from('000001234500', 'ascii'), // 잔액 12자리(좌측 0)
          KR.홍길동, Buffer.from('    ', 'ascii'), // 고객명 10바이트(EUC-KR 6 + 공백 4)
        ])
      } else {
        resp = Buffer.concat([Buffer.from('99', 'ascii'), Buffer.from('000000000000', 'ascii'), Buffer.from(' '.repeat(10), 'ascii')])
      }
      const prefix = Buffer.from(String(resp.length).padStart(4, '0'), 'ascii')
      socket.write(Buffer.concat([prefix, resp]))
      console.log(`[mock] TCP ${txCode} acctNo=${acctNo} → ${resp.length}B 응답`)
    }
  })
})

server.listen(PORT, () => {
  console.log(`[mock] FlowLink mock 시작 — http://localhost:${PORT} (안내: / · OpenAPI: /openapi.json)`)
  if (!eucKrDecoder) console.log('[mock] ⚠ TextDecoder(euc-kr) 미지원 Node — 레거시 요청의 한글 디코딩이 제한됩니다')
})
tcpServer.listen(TCP_PORT, () => {
  console.log(`[mock] TCP 전문 서버 — localhost:${TCP_PORT} (BAL1 잔액조회)`)
})
