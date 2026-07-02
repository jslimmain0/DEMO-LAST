#!/usr/bin/env node
/**
 * FlowLink relay — wait(콜백 대기) 노드의 콜백/노티 수신기.
 * 단일 파일 · node:http · 의존성 0. 실행: `node relay.js [port]` 또는 PORT (기본 8787)
 *
 * 프로토콜 (설계: docs/superpowers/specs/2026-07-03-form-wait-relay-design.md)
 *   POST /exec/{실행ID}/register   wait 노드별 {contentType, body} 응답 설정 저장
 *   GET  /events/{실행ID}          SSE — 연결 즉시 기수신분 재생, 25초 ping
 *   ANY  /cb/{실행ID}/{노드ID}     콜백 수신 → 보관 + SSE 전원 전달 + 등록된 응답 반환(미등록 "OK")
 *                                  GET 은 쿼리스트링을 본문으로 취급 (returnUrl?resultCode=... 리다이렉트 지원)
 *   GET  /health                   {ok, execs}
 *   그 외                          frontend/dist 정적 서빙 (없는 경로는 index.html — SPA 폴백)
 *
 * 상태는 전부 메모리 — 실행ID별 마지막 접근 2시간 후 자동 정리(SSE 종료), 재시작하면 소멸.
 * 모든 응답 CORS 오픈. 콜백 발신자 인증 없음(사내 테스트망 전제) — 실행ID가 사실상의 비밀값.
 */
'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || process.env.PORT || 8787)
const DIST = path.join(__dirname, 'frontend', 'dist')
const EXEC_TTL_MS = 2 * 60 * 60 * 1000 // 마지막 접근 후 2시간
const MAX_BODY = 1024 * 1024 // 콜백/등록 본문 상한 1MB

/** 실행ID → { responses: {nodeId: {contentType, body}}, events: [수신 콜백…], clients: Set<res>, lastAccess } */
const execs = new Map()

function touch(execId) {
  let ex = execs.get(execId)
  if (!ex) {
    ex = { responses: {}, events: [], clients: new Set(), lastAccess: Date.now() }
    execs.set(execId, ex)
  }
  ex.lastAccess = Date.now()
  return ex
}

// 2시간 무접근 실행 정리 — SSE 도 닫는다
setInterval(() => {
  const now = Date.now()
  for (const [id, ex] of execs) {
    if (now - ex.lastAccess > EXEC_TTL_MS) {
      for (const client of ex.clients) {
        try { client.end() } catch { /* 이미 닫힘 */ }
      }
      execs.delete(id)
      console.log(`[relay] ${id} 만료 정리`)
    }
  }
}, 10 * 60 * 1000).unref()

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
}

function readBody(req, cb) {
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
  req.on('end', () => { if (!done) { done = true; cb(Buffer.concat(chunks).toString('utf8')) } })
  req.on('error', () => { if (!done) { done = true; cb(null) } })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** 등록된 응답 설정({contentType, body}) → 실제 Content-Type. 축약어(text/html/json)와 mime 둘 다 허용. */
function contentTypeOf(conf) {
  const t = (conf && conf.contentType ? String(conf.contentType) : 'text').toLowerCase()
  if (t.includes('/')) return t + (t.includes('charset') ? '' : '; charset=utf-8')
  if (t === 'html') return 'text/html; charset=utf-8'
  if (t === 'json') return 'application/json; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(req, res, pathname) {
  // dist 밖으로 못 나가게 정규화(경로 탈출 방지). 없는 경로는 SPA index.html 폴백.
  // 잘못된 percent-encoding(decodeURIComponent throw)도 index.html 폴백 — 프로세스가 죽으면 안 된다.
  let decoded = 'index.html'
  try { decoded = decodeURIComponent(pathname) } catch { /* malformed escape */ }
  const safe = path.normalize(decoded).replace(/^([.][.][/\\])+/, '')
  let file = path.join(DIST, safe)
  if (!file.startsWith(DIST)) file = path.join(DIST, 'index.html')
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(DIST, 'index.html')
    fs.readFile(file, (err2, data) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('relay: 정적 파일 없음 — frontend/dist 를 빌드하세요 (npm run build)')
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
      res.end(data)
    })
  })
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res)
  } catch (e) {
    // 어떤 요청도 relay 프로세스를 죽일 수 없다 — 진행 중 실행(SSE/버퍼) 전체가 날아가기 때문.
    console.error('[relay] 요청 처리 오류:', e && e.message ? e.message : e)
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('relay error')
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
  const parts = u.pathname.split('/').filter(Boolean)

  // POST /exec/{실행ID}/register — wait 노드별 응답 설정 저장
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'exec' && parts[2] === 'register') {
    const ex = touch(parts[1])
    readBody(req, (body) => {
      if (body === null) return sendJson(res, 413, { ok: false, error: 'body too large' })
      try {
        const parsed = JSON.parse(body || '{}')
        const responses = parsed.responses && typeof parsed.responses === 'object' ? parsed.responses : parsed
        for (const [nodeId, conf] of Object.entries(responses || {})) {
          if (conf && typeof conf === 'object') {
            ex.responses[nodeId] = { contentType: conf.contentType, body: String(conf.body ?? '') }
          }
        }
        sendJson(res, 200, { ok: true, nodes: Object.keys(ex.responses).length })
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid JSON' })
      }
    })
    return
  }

  // GET /events/{실행ID} — SSE. 연결 즉시 기수신분 재생 + 25초 ping
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'events') {
    const ex = touch(parts[1])
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    for (const ev of ex.events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`) // 재생 — 이미 소비된 노드의 중복 이벤트는 무해(프론트 버퍼)
    }
    ex.clients.add(res)
    const ping = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* 닫힘 — close 에서 정리 */ }
    }, 25_000)
    req.on('close', () => {
      clearInterval(ping)
      ex.clients.delete(res)
    })
    return
  }

  // ANY /cb/{실행ID}/{노드ID} — 콜백 수신
  if (parts.length === 3 && parts[0] === 'cb') {
    const [, execId, nodeId] = parts
    const ex = touch(execId)
    const finish = (bodyText) => {
      const ev = {
        nodeId,
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
        ),
        body: bodyText ?? '',
        ts: Date.now(),
      }
      ex.events.push(ev)
      const data = `data: ${JSON.stringify(ev)}\n\n`
      for (const client of ex.clients) {
        try { client.write(data) } catch { /* 끊긴 클라이언트 — close 에서 정리 */ }
      }
      console.log(`[relay] cb ${execId}/${nodeId} ${req.method} body=${(bodyText || '').slice(0, 200)}`)
      const conf = ex.responses[nodeId]
      if (conf) {
        res.writeHead(200, { 'Content-Type': contentTypeOf(conf) })
        res.end(conf.body)
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('OK')
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      finish(u.search.startsWith('?') ? u.search.slice(1) : u.search) // 쿼리스트링을 본문으로
    } else {
      readBody(req, (body) => {
        if (body === null) {
          // 상한 초과/수신 오류 — 빈 본문 이벤트로 조용히 전달하지 않고 명시적으로 거절한다
          res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('payload too large')
          return
        }
        finish(body)
      })
    }
    return
  }

  // GET /health
  if (req.method === 'GET' && u.pathname === '/health') {
    return sendJson(res, 200, { ok: true, execs: execs.size })
  }

  // 그 외 — 정적 서빙(dist)
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, u.pathname === '/' ? '/index.html' : u.pathname)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
}

server.listen(PORT, () => {
  console.log(`[relay] FlowLink relay 시작 — http://localhost:${PORT} (dist: ${DIST})`)
})
