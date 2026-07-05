#!/usr/bin/env node
/**
 * FlowLink 워크플로 등록 헬퍼.
 * 그래프 JSON({ name, nodes, edges })을 받아 REST API로 flow를 만들고 그래프를 저장한다.
 * (선택) --run 이면 실행까지 한다.
 *
 * 사용법:
 *   node register-flow.mjs <graph.json> [옵션]
 *   cat graph.json | node register-flow.mjs -            # stdin
 *
 * 옵션:
 *   --base <url>   백엔드 base (기본 http://localhost:18080)
 *   --import       POST /flows/import 로 한 번에 적재(v1) — 기본은 create+saveVersion(v2)
 *   --run          저장 후 POST /flows/{id}/runs 로 실행(순수 서버 노드만이면 완결)
 *   --name <이름>   graph.name 대신 flow 이름 지정
 *
 * 출력(JSON): { flowId, versionNo?, status?, editorUrl }
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const src = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true) || args[0]
const base = opt('--base', 'http://localhost:18080').replace(/\/$/, '')
const api = `${base}/api/v1`
const H = { 'Content-Type': 'application/json' }

function readGraph() {
  const path = args.find((a) => a === '-' || (!a.startsWith('--') && a.endsWith('.json')))
  const raw = path === '-' || !path ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  const g = JSON.parse(raw)
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('graph 에 nodes/edges 배열이 필요합니다')
  return g
}

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${url} → ${r.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const graph = readGraph()
const name = opt('--name', graph.name || '새 워크플로')
graph.name = name

let flowId
let versionNo
if (flag('--import')) {
  // 한 번에: import 는 새 flow 의 v1 로 그래프를 곧바로 적재
  const detail = await post(`${api}/flows/import`, { name, nodes: graph.nodes, edges: graph.edges })
  flowId = detail.id
  versionNo = detail.currentVersion
} else {
  // 2단계: flow 생성(빈 v1) → 그래프를 새 버전(v2)으로 저장
  const flow = await post(`${api}/flows`, { name })
  flowId = flow.id
  const version = await post(`${api}/flows/${flowId}/versions`, { graph, note: 'flowlink-workflow 스킬 생성' })
  versionNo = version.versionNo
}

const out = { flowId, versionNo, editorUrl: `http://localhost:5173/flows/${flowId}` }

if (flag('--run')) {
  const exec = await post(`${api}/flows/${flowId}/runs`, {})
  out.status = exec.status
  out.executionId = exec.id
  if (exec.pendingForm || exec.pendingWait || exec.pendingInput || exec.pendingClient) {
    out.note = 'WAITING — 브라우저 협업 노드(form/wait/input/client)가 있어 에디터에서 ▶ 실행해야 완결됩니다.'
  }
}

console.log(JSON.stringify(out, null, 2))
