// relay(relay.js) 클라이언트 — wait(콜백 대기) 노드의 콜백 수신 세션.
// 실행 시작 직전에 실행ID(crypto 영숫자 16자)를 만들어 노드별 응답을 등록하고 SSE 를 연결한다.
// 등록/연결 실패는 즉시 실패가 아니라 기억해뒀다가, wait 노드에 도달했을 때 그 에러로 실패시킨다
// (http/set/form 만 있는 시나리오는 relay 없이도 돈다).
import type { GraphNode } from '../api/types'
import { newId } from './ids'

export const DEFAULT_RELAY_BASE = 'http://localhost:8787'

export function relayBase(): string {
  try {
    const v = localStorage.getItem('fl:relayBase')
    return v && v.trim() ? v.trim().replace(/\/+$/, '') : DEFAULT_RELAY_BASE
  } catch {
    return DEFAULT_RELAY_BASE
  }
}

export function saveRelayBase(v: string) {
  try {
    localStorage.setItem('fl:relayBase', v.trim())
  } catch {
    /* 저장 불가(프라이빗 모드 등) 무시 */
  }
}

/** relay 가 SSE 로 전달하는 수신 콜백 전문. */
export interface RelayEvent {
  nodeId: string
  method: string
  url?: string
  headers?: Record<string, string>
  body?: string
  ts?: number
}

/**
 * 실행 1회분의 relay 세션. 노드ID별 버퍼 큐로 타이밍 문제를 방어한다 —
 * 콜백이 wait 노드 도달 전에 도착하면(예: 승인 응답보다 노티가 먼저) 버퍼에 쌓였다가 도달 즉시 소비된다.
 * relay 쪽도 SSE 연결 전 수신분을 보관·재생하므로 2중 버퍼링. 같은 노드의 중복 콜백은 첫 번째만 소비.
 */
export class RelaySession {
  readonly runId = newId(16)
  readonly base = relayBase()
  /** register/SSE 실패 사유 — wait 노드 도달 시 이 에러로 노드를 실패시킨다. */
  error: string | null = null
  private es: EventSource | null = null
  private buffers = new Map<string, RelayEvent[]>()
  private waiters = new Map<string, (ev: RelayEvent) => void>()

  urlFor(nodeId: string): string {
    return `${this.base}/cb/${this.runId}/${nodeId}`
  }

  /** wait 노드별 콜백 응답 설정을 등록하고 SSE 를 연결한다. 실패는 error 에 기억(즉시 실패 아님). */
  async start(waitNodes: GraphNode[]): Promise<void> {
    const responses: Record<string, { contentType?: string; body: string }> = {}
    for (const n of waitNodes) {
      // 응답 본문의 {{ url@노드ID }} 토큰은 등록 시점에 치환 — 실행 도중 얻은 값은 반영되지 않는다
      // (실질적으로 정적 텍스트 + 수신 URL 정도)
      const body = (n.callbackRespBody ?? 'OK').replace(
        /\{\{\s*url@([A-Za-z0-9]+)\s*\}\}/g,
        (_, id: string) => this.urlFor(id),
      )
      responses[n.id] = { contentType: n.callbackRespType ?? 'text', body }
    }
    try {
      const res = await fetch(`${this.base}/exec/${this.runId}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
        // 도달 불가 주소(방화벽 drop 등)에서 실행이 오래 매달리지 않게 — 실패는 error 로 기억되고 진행
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`register ${res.status}`)
      this.es = new EventSource(`${this.base}/events/${this.runId}`)
      // EventSource 는 끊겨도 자동 재연결 — 재연결 시 relay 가 기수신분을 전부 재생한다.
      // 이미 소비된 노드의 중복 이벤트는 버퍼에 쌓일 뿐 무해(플로우는 DAG — 같은 노드를 두 번 대기하지 않음).
      this.es.onmessage = (e) => {
        try {
          this.push(JSON.parse(e.data) as RelayEvent)
        } catch {
          /* 형식 밖 이벤트 무시 */
        }
      }
    } catch (e) {
      this.error = `relay(${this.base}) 연결 실패 — relay.js 실행 여부를 확인하세요. (${e instanceof Error ? e.message : String(e)})`
    }
  }

  private push(ev: RelayEvent) {
    if (!ev || !ev.nodeId) return
    const waiter = this.waiters.get(ev.nodeId)
    if (waiter) {
      this.waiters.delete(ev.nodeId)
      waiter(ev)
      return
    }
    const q = this.buffers.get(ev.nodeId) ?? []
    q.push(ev)
    this.buffers.set(ev.nodeId, q)
  }

  /** 노드의 콜백 하나를 소비 — 버퍼에 있으면 즉시, 없으면 도착까지 대기. */
  take(nodeId: string): Promise<RelayEvent> {
    const q = this.buffers.get(nodeId)
    if (q && q.length > 0) return Promise.resolve(q.shift() as RelayEvent)
    return new Promise((resolve) => {
      this.waiters.set(nodeId, resolve)
    })
  }

  /** 대기 취소(타임아웃/중단) — 등록된 waiter 를 제거해 늦은 콜백이 버퍼로 가게 한다. */
  cancelWait(nodeId: string) {
    this.waiters.delete(nodeId)
  }

  close() {
    this.es?.close()
    this.es = null
    this.waiters.clear()
  }
}
