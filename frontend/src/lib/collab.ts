import type { Edge, Node } from '@xyflow/react'
import { presence } from './presence'
import { useEditorStore } from '../store/editorStore'

/**
 * 실시간 공동 편집 브리지 — editorStore 의 그래프(nodes/edges) 변경을 presence WebSocket 으로 중계하고,
 * 원격 스냅샷을 받아 적용한다. 방식: **전체 그래프 last-write-wins**(throttle 100ms + 서명 dedup).
 * - 위치/추가/삭제/연결/속성편집 등 모든 편집이 하나의 경로로 공유된다(구현 단순·견고).
 * - ⚠ 두 사람이 정확히 동시(같은 100ms 창)에 서로 다른 편집을 하면 마지막 것이 이김(드물게 발산 —
 *   다음 편집/새로고침으로 수렴). 턴 주고받기·한 명 편집+관전 같은 일반 사용은 매끄럽게 동작.
 */
const THROTTLE = 100

let applying = false          // 원격 적용 중 — 로컬 재전송(에코) 억제
let unsub: (() => void) | null = null
let timer: number | undefined
let pending: { nodes: unknown[]; edges: unknown[] } | null = null
let lastSig = ''
let lastSentAt = 0

/** RF 노드/엣지에서 공유에 필요한 필드만 추림(선택/드래그/측정 등 로컬 전용 상태 제거). */
function strip(nodes: Node[], edges: Edge[]) {
  const n = nodes.map((nd) => ({
    id: nd.id, type: nd.type, position: nd.position, data: nd.data,
    ...(nd.zIndex !== undefined ? { zIndex: nd.zIndex } : {}),
    ...(nd.dragHandle ? { dragHandle: nd.dragHandle } : {}),
  }))
  const e = edges.map((ed) => ({
    id: ed.id, source: ed.source, target: ed.target,
    sourceHandle: ed.sourceHandle, type: ed.type,
  }))
  return { n, e }
}
const sigOf = (n: unknown[], e: unknown[]) => JSON.stringify([n, e])

export function startCollab() {
  presence.onGraph((m) => {
    const nodes = m.nodes as Node[] | undefined
    const edges = m.edges as Edge[] | undefined
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return
    applying = true
    try {
      lastSig = sigOf(nodes, edges) // 받은 상태를 기준선으로 → 곧바로 되쏘지 않음
      useEditorStore.getState().applyRemoteGraph(nodes, edges)
    } finally { applying = false }
  })
  unsub = useEditorStore.subscribe((s, prev) => {
    if (applying) return
    if (s.nodes === prev.nodes && s.edges === prev.edges) return
    // 로드/초기화(dirty=false)는 공유하지 않는다 — 새로 접속한 사람의 "저장본 로드"가
    // 기존 참여자의 미저장 편집을 덮어쓰는 것을 막는다(실제 편집=dirty 만 중계).
    if (!s.dirty) return
    schedule(s.nodes, s.edges)
  })
}

export function stopCollab() {
  presence.onGraph(null)
  unsub?.(); unsub = null
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  pending = null; lastSig = ''; lastSentAt = 0
}

function schedule(nodes: Node[], edges: Edge[]) {
  const { n, e } = strip(nodes, edges)
  const sig = sigOf(n, e)
  if (sig === lastSig) return // 구조/데이터 변화 없음(선택만 바뀜 등)은 안 보냄
  pending = { nodes: n, edges: e }
  if (timer !== undefined) return // 이미 트레일링 대기 중 — pending 만 갱신
  const wait = Math.max(0, THROTTLE - (Date.now() - lastSentAt))
  timer = window.setTimeout(flush, wait)
}

function flush() {
  timer = undefined
  if (!pending) return
  lastSig = sigOf(pending.nodes, pending.edges)
  lastSentAt = Date.now()
  presence.sendGraph(pending)
  pending = null
}
