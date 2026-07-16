import { toast } from '../components/toast'
import { usePresenceStore, type Peer } from '../store/presenceStore'

/** dev 모드 닉네임 — 브라우저별 1회 생성해 localStorage 에 유지. */
export function devNickname(): string {
  let n = localStorage.getItem('fl:nick')
  if (!n) {
    n = '게스트-' + Math.random().toString(36).slice(2, 6)
    localStorage.setItem('fl:nick', n)
  }
  return n
}

const CURSOR_MS = 50 // 커서 전송 쓰로틀(트레일링 — 마지막 위치는 반드시 전송)

/**
 * presence WebSocket 세션(에디터당 1개 — 모듈 싱글턴).
 * 끊기면 2초 후 자동 재접속(사용자가 close 하기 전까지). 수신은 presenceStore 로만 반영 —
 * editorStore(dirty/undo/selected)는 절대 건드리지 않는다.
 */
class PresenceSession {
  private ws: WebSocket | null = null
  private flowId: string | null = null
  private name = ''
  private tokenFn: (() => string | null) | null = null
  private retry: number | undefined
  private lastSent = 0
  private pending: { x: number | null; y: number | null } | null = null
  private cursorTimer: number | undefined
  private editing: string | null = null   // 현재 편집중 노드 — 재접속 시 재announce

  connect(flowId: string, name: string, tokenFn?: () => string | null) {
    this.close()
    this.flowId = flowId
    this.name = name
    this.tokenFn = tokenFn ?? null
    this.open()
  }

  private open() {
    if (!this.flowId) return
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let url = `${proto}://${location.host}/ws/presence?flowId=${this.flowId}&name=${encodeURIComponent(this.name)}`
    const token = this.tokenFn?.()
    if (token) url += `&token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    ws.onopen = () => {
      // 재접속(백엔드 재시작 등) 후 편집중 상태를 다시 알림 — 안 그러면 상대에게 링이 안 보인다
      if (this.ws === ws && this.editing) this.send({ t: 'editing', nodeId: this.editing })
    }
    ws.onmessage = (ev) => {
      try { this.dispatch(JSON.parse(ev.data as string)) } catch { /* 프레임 파싱 실패 무시 */ }
    }
    ws.onclose = () => {
      // ⚠ reset 은 반드시 현재 세션 소켓일 때만 — 옛 소켓의 늦은 onclose 가 새 세션 상태를 지우지 않게
      // (플로우 전환·StrictMode 이중 마운트에서 old.onclose 가 new.hello 뒤에 도착할 수 있음)
      if (this.ws === ws) {
        usePresenceStore.getState().reset()
        this.ws = null
        // 사용자가 close() 한 게 아니면 재접속(백엔드 재시작·네트워크 순단 대응)
        this.retry = window.setTimeout(() => this.open(), 2000)
      }
    }
    this.ws = ws
  }

  private dispatch(m: { t: string } & Record<string, unknown>) {
    const st = usePresenceStore.getState()
    switch (m.t) {
      case 'hello': st.hello(m.id as string, m.peers as Peer[]); break
      case 'join': st.join(m.peer as Peer); break
      case 'leave': st.leave(m.id as string); break
      case 'cursor': st.cursor(m.id as string, m.x as number | null, m.y as number | null); break
      case 'editing': st.editing(m.id as string, m.nodeId as string | null); break
      case 'saved': toast(`${m.name} 님이 이 워크플로를 저장했습니다`); break
    }
  }

  private send(o: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o))
  }

  /** 50ms 트레일링 쓰로틀 — 조용해지면 마지막 좌표가 반드시 나간다. */
  sendCursor(x: number, y: number) {
    this.pending = { x, y }
    const now = Date.now()
    if (now - this.lastSent >= CURSOR_MS) this.flushCursor()
    else if (this.cursorTimer === undefined) {
      this.cursorTimer = window.setTimeout(() => this.flushCursor(), CURSOR_MS - (now - this.lastSent))
    }
  }

  hideCursor() {
    this.pending = { x: null, y: null }
    this.flushCursor()
  }

  private flushCursor() {
    if (this.cursorTimer !== undefined) { clearTimeout(this.cursorTimer); this.cursorTimer = undefined }
    if (!this.pending) return
    this.lastSent = Date.now()
    this.send({ t: 'cursor', ...this.pending })
    this.pending = null
  }

  sendEditing(nodeId: string | null) { this.editing = nodeId; this.send({ t: 'editing', nodeId }) }
  sendSaved() { this.send({ t: 'saved' }) }

  close() {
    if (this.retry !== undefined) { clearTimeout(this.retry); this.retry = undefined }
    if (this.cursorTimer !== undefined) { clearTimeout(this.cursorTimer); this.cursorTimer = undefined }
    const ws = this.ws
    this.ws = null // onclose 의 재접속·reset 분기 차단
    ws?.close()
    usePresenceStore.getState().reset()
    this.flowId = null
    this.pending = null
    this.editing = null
  }
}

export const presence = new PresenceSession()
