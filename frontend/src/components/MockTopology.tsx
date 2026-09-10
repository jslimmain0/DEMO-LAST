import { Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MiniMap, Panel, Position, ReactFlow, getNodesBounds, useEdgesState, useNodesState } from '@xyflow/react'
import type { Edge, EdgeProps, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MockFleet, MockFleetServer, MockFleetWorkspace } from '../api/types'
import { mockBaseUrl } from '../api/client'
import { relTime } from '../lib/format'

export type ServerAction = 'toggle' | 'rename' | 'duplicate' | 'export' | 'delete' | 'fav' | 'copyUrl' | 'move' | 'goFlow'
export type FleetFilter = 'all' | 'on' | 'off' | 'live' | 'unmatched' | 'fav'

/**
 * Mock 서버 토폴로지 — Mock 화면의 **유일한 보기**(목록 없음). 캔버스(React Flow) 위의 포트 중심 노드 맵 + 목록이 하던 기능 전부.
 * - 왼쪽 **허브**(호스트 · HTTP 게이트웨이 포트 · TCP 포트 수) → 워크스페이스 **존**마다 **스파인**(세로 버스) → 존 안 서버 노드로 가로 탭.
 *   선이 노드를 가로지르지 않는다(스파인은 두 열 사이 거터). 존은 세로로 쌓인다(내 소속 먼저, 남의 것은 점선 + 🔒).
 * - 서버 노드: **포트가 제일 크게**(`:9091` / `:8888` + `/mock/slug`) · 상태 LED · 라우트/규칙·마지막 요청·버전·↗ 워크플로.
 *   요청이 들어오면 LED 펄스 + 글로우 + 선이 흐른다. 꺼지면 점선·흐림. 호버=상세 카드 + 도구(⏻ 켜기/끄기 · ⋯ 메뉴: 이름·복제·내보내기·이동·삭제·즐겨찾기·URL 복사·워크플로).
 *   클릭=편집기(접근 불가는 열리지 않음), Ctrl/Shift+클릭 또는 선택 모드=선택(일괄 작업). 검색/필터에 안 맞는 노드는 흐려진다.
 * - 위치는 데이터에서 계산(드래그 없음), 5초 폴링마다 상태만 갱신. 캔버스 높이는 내용에 맞춰 늘어난다(최대 1000).
 */
export function MockTopology({ fleet, host, tenant, match, selected, selectMode, favs, canEditGlobal, wsOptions, onOpen, onToggleSelect, onAction, onCreateIn }: {
  fleet: MockFleet
  host: string
  tenant?: string | null
  match: ((s: MockFleetServer) => boolean) | null     // null = 전부 표시
  selected: Set<string>
  selectMode: boolean
  favs: Set<string>
  canEditGlobal: boolean
  wsOptions: MockFleetWorkspace[]                     // 이동 대상(쓰기 가능한 워크스페이스)
  onOpen: (s: MockFleetServer) => void
  onToggleSelect: (s: MockFleetServer) => void
  onAction: (s: MockFleetServer, action: ServerAction, arg?: string) => void
  onCreateIn: (wsId: string) => void
}) {
  const layout = useMemo(() => buildGraph(fleet, host, tenant), [fleet, host, tenant])
  // 배치(위치)는 fleet 에서만, UI 상태(검색/선택/즐겨찾기)는 데이터에 덧씌운다 — 선택할 때마다 재배치하지 않게
  const decorated = useMemo(() => ({
    ...layout,
    nodes: layout.nodes.map((n) => {
      if (n.type === 'fserver') {
        const s = (n.data as { server: MockFleetServer }).server
        const editable = canEditGlobal && s.readable && s.myRole !== 'VIEWER'
        return { ...n, data: { ...n.data, dim: match ? !match(s) : false, selected: selected.has(s.id), fav: favs.has(s.id), selectMode, editable, wsOptions, onAction, onToggleSelect } }
      }
      if (n.type === 'fzone') {
        const w = (n.data as { ws: MockFleetWorkspace }).ws
        return { ...n, data: { ...n.data, canCreate: canEditGlobal && (w.myRole === 'OWNER' || w.myRole === 'EDITOR'), onCreate: onCreateIn } }
      }
      return n
    }),
  }), [layout, match, selected, favs, selectMode, canEditGlobal, wsOptions, onAction, onToggleSelect, onCreateIn])
  // onNodesChange 를 꼭 넘겨야 측정(dimensions) 변경이 nodes 에 반영된다 — 없으면 미니맵이 노드를 못 그리고 bounds 도 0 크기
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(decorated.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(decorated.edges)
  const inst = useRef<ReactFlowInstance<Node, Edge> | null>(null)
  const shapeRef = useRef('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const height = Math.min(1000, Math.max(440, Math.round(layout.contentH * 0.82) + 56))
  /** 맞춤 — RF fitView 는 비동기(다음 프레임)라 뷰포트를 직접 계산: 다 들어가면 가운데, 줌 하한에 걸려 넘치면 왼쪽 위(허브·첫 존)부터. */
  const fit = (i: ReactFlowInstance<Node, Edge> | null) => {
    const el = wrapRef.current
    if (!i || !el) return
    const b = getNodesBounds(i.getNodes())
    if (!(b.width > 0 && b.height > 0)) return
    const cw = el.clientWidth, ch = el.clientHeight, pad = 26
    const z = Math.min(FIT.maxZoom, Math.max(FIT.minZoom, Math.min((cw - pad * 2) / b.width, (ch - pad * 2) / b.height)))
    const fits = b.width * z <= cw - pad * 2 && b.height * z <= ch - pad * 2
    void i.setViewport({ x: (fits ? (cw - b.width * z) / 2 : pad) - b.x * z, y: (fits ? (ch - b.height * z) / 2 : 18) - b.y * z, zoom: z })
  }
  useEffect(() => {
    setNodes(decorated.nodes); setEdges(decorated.edges)
    // 서버 집합/존 배치가 바뀌었을 때만 맞춤(상태 폴링·선택마다 뷰가 튀지 않게)
    const shape = layout.nodes.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join('|')
    if (shape !== shapeRef.current) { shapeRef.current = shape; setTimeout(() => fit(inst.current), 60) }
  }, [decorated, layout, setNodes, setEdges])
  return (
    <div ref={wrapRef} className="fl-topology" aria-label="서버 토폴로지" style={{ height, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', overflow: 'hidden', position: 'relative' }}>
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        onInit={(i) => { inst.current = i; setTimeout(() => fit(i), 60) }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnScroll zoomOnDoubleClick={false} minZoom={0.25} maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(e, n) => {
          const s = (n.data as { server?: MockFleetServer }).server
          if (!s) return
          if (selectMode || e.ctrlKey || e.metaKey || e.shiftKey) onToggleSelect(s)
          else if (s.readable) onOpen(s)
        }}>
        <Background gap={22} color="var(--fl-border)" />
        <MiniMap pannable zoomable nodeStrokeWidth={0} nodeBorderRadius={4} maskColor="rgba(120,120,140,0.18)" nodeColor={(n) => {
          const s = (n.data as { server?: MockFleetServer }).server
          if (!s) return n.type === 'fzone' ? 'rgba(124,92,255,0.10)' : n.type === 'fspine' ? 'transparent' : '#7c5cff'
          return serverState(s) === 'on' ? '#16a34a' : serverState(s) === 'fail' ? '#dc2626' : '#b4b8c8'
        }} style={{ background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 8 }} />
        <Controls showInteractive={false} />
        <Panel position="top-right" style={legend}>
          <span><i style={{ ...dot, background: 'var(--fl-ok)' }} /> 서빙 중 · 리스닝</span>
          <span><i style={{ ...dot, background: 'var(--fl-fail)' }} /> 바인딩 실패</span>
          <span><i style={{ ...dot, background: 'var(--fl-border-strong, var(--fl-border))' }} /> 꺼짐</span>
          <span><i style={{ width: 18, height: 0, borderTop: '2px dashed var(--fl-ok)', display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} /> 요청 흐름</span>
          <span>🔒 읽기 전용</span>
          <span style={{ color: 'var(--fl-text-muted)' }}>클릭=열기 · Ctrl+클릭=선택 · 호버=도구</span>
        </Panel>
      </ReactFlow>
    </div>
  )
}

// ---------- 그래프 조립(위치 계산) ----------

const NODE_W = 260, NODE_H = 84, ROW = 100, ZONE_PAD = 20, ZONE_HEAD = 50, GAP = 100, HUB_W = 290, ZONE_X = HUB_W + 80, ZONE_GAP = 36, ZONE_Y0 = 132
const ZONE_W = ZONE_PAD * 2 + NODE_W * 2 + GAP
/** 맞춤 줌 — 서버가 많아도 노드가 너무 작아지지 않게 하한(0.7)을 두고 넘치면 팬으로 본다. */
const FIT = { minZoom: 0.7, maxZoom: 1.05 }
export type ServerState = 'on' | 'off' | 'fail'
export function serverState(s: MockFleetServer): ServerState {
  return s.kind === 'TCP' ? (s.listening ? 'on' : s.listenError ? 'fail' : 'off') : (s.enabled ? 'on' : 'off')
}
const stateColor = (st: ServerState, kindColor: string) => (st === 'on' ? kindColor : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, var(--fl-border))')
const kindColorOf = (isTcp: boolean) => (isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-http, var(--fl-primary))')

function buildGraph(f: MockFleet, host: string, tenant: string | null | undefined): { nodes: Node[]; edges: Edge[]; contentH: number } {
  const byWs = new Map<string, MockFleetServer[]>()
  for (const s of f.servers) { const a = byWs.get(s.workspaceId) ?? []; a.push(s); byWs.set(s.workspaceId, a) }
  // 켜진 것 → HTTP 먼저 → 포트/이름순
  for (const a of byWs.values()) a.sort((x, y) => Number(serverState(y) === 'on') - Number(serverState(x) === 'on') || (x.kind === 'TCP' ? 1 : 0) - (y.kind === 'TCP' ? 1 : 0) || (x.tcpPort ?? 0) - (y.tcpPort ?? 0) || x.name.localeCompare(y.name, 'ko'))
  const rank = (w: MockFleetWorkspace) => (w.kind === 'PUBLIC' ? 0 : w.kind === 'PERSONAL' ? 1 : 2)
  const sorted = [...f.workspaces].sort((a, b) => Number(b.mine) - Number(a.mine) || rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'))
  const zones = sorted.filter((w) => w.mine || (byWs.get(w.id)?.length ?? 0) > 0)

  const nodes: Node[] = []
  const edges: Edge[] = []
  const anyLive = f.servers.some((s) => s.recentRequests > 0)
  const tcpOpen = f.ports.filter((p) => p.kind === 'TCP' && p.state === 'LISTENING').length
  nodes.push({ id: 'hub', type: 'fhub', position: { x: 0, y: 0 }, data: { host, httpPort: f.httpPort, contextPath: f.contextPath, httpOn: f.ports.find((p) => p.kind === 'HTTP')?.count ?? 0, tcpOpen, tcpTotal: f.ports.filter((p) => p.kind === 'TCP').length, live: anyLive }, draggable: false, selectable: false })

  let y = ZONE_Y0
  for (const w of zones) {
    const servers = byWs.get(w.id) ?? []
    const n = servers.length
    const rows = Math.ceil(n / 2)
    const zh = n === 0 ? ZONE_HEAD + 40 : ZONE_HEAD + rows * ROW + ZONE_PAD - (ROW - NODE_H)
    const zid = `ws:${w.id}`
    const zx = ZONE_X
    nodes.push({ id: zid, type: 'fzone', position: { x: zx, y }, data: { ws: w, count: n, on: servers.filter((s) => serverState(s) === 'on').length, live: servers.filter((s) => s.recentRequests > 0).length }, style: { width: ZONE_W, height: zh }, zIndex: -1, draggable: false, selectable: false })
    if (n > 0) {
      // 스파인(세로 버스) — 두 열 사이 거터 한가운데. 허브 업링크가 위로 들어오고, 서버마다 가로 탭이 나간다.
      const spineX = zx + ZONE_PAD + NODE_W + GAP / 2
      const spineTop = y + ZONE_HEAD - 10
      const spineH = rows * ROW - (ROW - NODE_H) / 2 + 10
      const sid = `sp:${w.id}`
      nodes.push({ id: sid, type: 'fspine', position: { x: spineX - 1, y: spineTop }, data: { live: servers.some((s) => s.recentRequests > 0) }, style: { width: 2, height: spineH }, zIndex: 0, draggable: false, selectable: false })
      const httpOn = servers.filter((s) => s.kind !== 'TCP' && serverState(s) === 'on').length
      const tcpOn = servers.filter((s) => s.kind === 'TCP' && serverState(s) === 'on').length
      const zoneLive = servers.some((s) => s.recentRequests > 0)
      const upColor = httpOn + tcpOn > 0 ? 'var(--fl-ok)' : 'var(--fl-border-strong, var(--fl-border))'
      edges.push({ id: `up:${w.id}`, source: 'hub', sourceHandle: 'r', target: sid, targetHandle: 't', type: 'felbow', animated: zoneLive,
        data: { mode: 'HV', label: `HTTP ×${httpOn} · TCP ×${tcpOn}`, color: upColor },
        style: { stroke: upColor, strokeWidth: zoneLive ? 2.4 : 1.8, strokeDasharray: httpOn + tcpOn > 0 ? undefined : '5 5' } })
      servers.forEach((s, i) => {
        const col = i % 2, row = Math.floor(i / 2)
        const nx = col === 0 ? zx + ZONE_PAD : zx + ZONE_PAD + NODE_W + GAP
        const ny = y + ZONE_HEAD + row * ROW
        nodes.push({ id: `m:${s.id}`, type: 'fserver', position: { x: nx, y: ny }, data: { server: s, host, tenant, httpPort: f.httpPort, contextPath: f.contextPath, side: col === 0 ? 'left' : 'right' }, draggable: false, selectable: false })
        const st = serverState(s), isTcp = s.kind === 'TCP', live = s.recentRequests > 0
        const color = stateColor(st, kindColorOf(isTcp))
        edges.push({ id: `tap:${s.id}`, source: sid, sourceHandle: 's', target: `m:${s.id}`, targetHandle: col === 0 ? 'r' : 'l', type: 'felbow', animated: live,
          data: { mode: 'TAP', label: isTcp && s.tcpPort != null ? `:${s.tcpPort}` : undefined, color },
          style: { stroke: color, strokeWidth: live ? 2.4 : 1.6, strokeDasharray: st === 'off' ? '4 4' : undefined, opacity: st === 'off' ? 0.7 : 1 } })
      })
    }
    y += zh + ZONE_GAP
  }
  return { nodes, edges, contentH: y - ZONE_GAP }
}

// ---------- 엣지: 꺾인 선(업링크 HV · 탭 = 스파인에서 노드 높이로 가로) ----------

function ElbowEdge({ id, sourceX, sourceY, targetX, targetY, data, style }: EdgeProps) {
  const d = (data ?? {}) as { mode?: 'HV' | 'TAP'; label?: string; color?: string }
  let path: string
  let lx = targetX, ly = targetY
  if (d.mode === 'TAP') {
    // 스파인(sourceX) 에서 노드 높이(targetY)로 가로 탭 — 세로 부분은 스파인 노드가 그린다(색이 겹쳐 지저분해지지 않게)
    path = `M ${sourceX} ${targetY} L ${targetX} ${targetY}`
    lx = (sourceX + targetX) / 2; ly = targetY - 9
  } else {
    // 허브 → 스파인 위: 가로로 간 뒤 모서리 돌아 세로로 내려간다
    const dirX = Math.sign(targetX - sourceX) || 1, dirY = Math.sign(targetY - sourceY) || 1
    const r = Math.min(12, Math.abs(targetX - sourceX) / 2, Math.abs(targetY - sourceY) / 2)
    path = `M ${sourceX} ${sourceY} L ${targetX - dirX * r} ${sourceY} Q ${targetX} ${sourceY} ${targetX} ${sourceY + dirY * r} L ${targetX} ${targetY}`
    lx = targetX + 10; ly = targetY - 8
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={style} />
      {d.label && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan" style={{ position: 'absolute', transform: `translate(${d.mode === 'TAP' ? '-50%' : '0'}, -100%) translate(${lx}px, ${ly}px)`, ...edgeLabel, color: d.color }}>{d.label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

// ---------- 노드 컴포넌트 ----------

function HubNode({ data }: NodeProps) {
  const d = data as { host: string; httpPort: number; contextPath: string; httpOn: number; tcpOpen: number; tcpTotal: number; live: boolean }
  return (
    <div style={hub} title="이 호스트에서 열려 있는 포트 — HTTP 는 앱 포트 하나로 /mock/{slug}/**, TCP 는 Mock 마다 포트">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={d.live ? 'fl-led-live' : undefined} style={{ ...led, width: 10, height: 10, background: 'var(--fl-ok)' }} />
        <span style={{ fontWeight: 800, fontSize: 13 }}>🖧 {d.host}</span>
      </div>
      <div style={{ display: 'grid', gap: 3, marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ ...kindTag, color: 'var(--fl-cat-http, var(--fl-primary))' }}>HTTP</span>
          <b style={{ ...mono, fontSize: 17, color: 'var(--fl-text)' }}>:{d.httpPort}</b>
          <span style={{ ...mono, fontSize: 11, whiteSpace: 'nowrap' }}>{d.contextPath}/mock/… · {d.httpOn}개 서빙</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ ...kindTag, color: 'var(--fl-cat-tcp, #7c5cff)' }}>TCP</span>
          <b style={{ ...mono, fontSize: 14, color: 'var(--fl-text)' }}>{d.tcpOpen}/{d.tcpTotal}</b>
          <span style={{ ...mono, fontSize: 11 }}>포트 열림</span>
        </div>
      </div>
      <Handle id="r" type="source" position={Position.Right} style={hiddenHandle} />
    </div>
  )
}

function ZoneNode({ data }: NodeProps) {
  const d = data as { ws: MockFleetWorkspace; count: number; on: number; live: number; canCreate?: boolean; onCreate?: (id: string) => void }
  const w = d.ws
  const icon = w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'
  const readable = w.myRole != null
  const roleLabel = !readable ? '접근 없음' : w.myRole === 'VIEWER' ? '읽기 전용' : w.myRole === 'OWNER' ? (w.mine ? '소유' : '관리자') : '편집'
  const roleColor = !readable ? 'var(--fl-fail)' : w.myRole === 'VIEWER' ? 'var(--fl-put, #f5a623)' : 'var(--fl-ok)'
  return (
    <div style={{ ...zone, borderStyle: w.mine ? 'solid' : 'dashed', background: w.mine ? 'color-mix(in srgb, var(--fl-primary) 4%, transparent)' : 'color-mix(in srgb, var(--fl-text-muted) 6%, transparent)' }} data-mine={w.mine}>
      <div className="fl-zone-head nodrag nopan" style={zoneHead}>
        <span aria-hidden>{icon}</span>
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 800, fontSize: 14, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
        <span style={{ ...roleChip, color: roleColor, borderColor: `color-mix(in srgb, ${roleColor} 40%, var(--fl-border))` }}>{(!readable || w.myRole === 'VIEWER') && '🔒 '}{roleLabel}</span>
        <span style={{ ...mono, fontSize: 11 }}>서버 {d.count} · 서빙 {d.on}{d.live ? ` · 요청 중 ${d.live}` : ''}</span>
        {d.canCreate && <button onClick={(e) => { e.stopPropagation(); d.onCreate?.(w.id) }} style={zoneBtn} title="이 워크스페이스에 새 Mock 만들기">+ Mock</button>}
      </div>
      {d.count === 0 && <div style={{ ...mono, position: 'absolute', left: ZONE_PAD, top: ZONE_HEAD + 10, fontSize: 11.5 }}>이 워크스페이스에는 아직 Mock 서버가 없습니다.</div>}
    </div>
  )
}

/** 스파인 — 존 가운데 세로 버스. 허브 업링크가 위로 들어오고 서버 탭이 옆으로 나간다. 요청이 흐르면 살짝 밝아진다. */
function SpineNode({ data }: NodeProps) {
  const d = data as { live: boolean }
  return (
    <div style={{ width: '100%', height: '100%', background: d.live ? 'var(--fl-ok)' : 'var(--fl-border-strong, var(--fl-border))', opacity: d.live ? 0.55 : 0.7, borderRadius: 2 }}>
      <Handle id="t" type="target" position={Position.Top} style={hiddenHandle} />
      <Handle id="s" type="source" position={Position.Top} style={hiddenHandle} />
    </div>
  )
}

type ServerData = {
  server: MockFleetServer; host: string; tenant?: string | null; httpPort: number; contextPath: string; side: 'left' | 'right'
  dim?: boolean; selected?: boolean; fav?: boolean; selectMode?: boolean; editable?: boolean; wsOptions?: MockFleetWorkspace[]
  onAction?: (s: MockFleetServer, action: ServerAction, arg?: string) => void; onToggleSelect?: (s: MockFleetServer) => void
}

function ServerNode({ data }: NodeProps) {
  const { server: s, host, tenant, httpPort, contextPath, side, dim, selected, fav, selectMode, editable, wsOptions = [], onAction, onToggleSelect } = data as ServerData
  const [hover, setHover] = useState(false)
  const [menu, setMenu] = useState(false)
  const [flows, setFlows] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const onDoc = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as globalThis.Node)) { setMenu(false); setFlows(false) } }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); setFlows(false) } }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey, true) }
  }, [menu])
  const st = serverState(s)
  const isTcp = s.kind === 'TCP'
  const live = s.recentRequests > 0
  const kindColor = kindColorOf(isTcp)
  const color = stateColor(st, kindColor)
  const ledColor = st === 'on' ? 'var(--fl-ok)' : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, #9aa0b2)'
  const readOnly = !s.readable || s.myRole === 'VIEWER'
  const fullAddress = isTcp ? `${host}:${s.tcpPort ?? '?'}` : mockBaseUrl(s.slug, tenant)
  const seg = tenant && tenant !== 'default' ? `${tenant}/${s.slug}` : s.slug
  const port = isTcp ? (s.tcpPort != null ? `:${s.tcpPort}` : ':—') : `:${httpPort}`
  const tail = isTcp ? host : `${contextPath}/mock/${seg}`
  const stateLabel = isTcp ? (st === 'on' ? '리스닝' : st === 'fail' ? '바인딩 실패' : '꺼짐') : (st === 'on' ? '서빙 중' : '꺼짐')
  const summary = !s.readable ? (isTcp ? `규칙 ${s.tcpRuleCount}` : `라우트 ${s.routeCount}`) + ' · 정의 비공개'
    : isTcp ? `필드 ${s.tcpFieldCount} · 규칙 ${s.tcpRuleCount}${s.hasCodec ? ' · ◈' : ''}` : `라우트 ${s.routeCount}${s.hasCodec ? ' · ◈' : ''}${s.environment ? ` · 🔑${s.environment}` : ''}`
  const act = (action: ServerAction, arg?: string) => { setMenu(false); setFlows(false); onAction?.(s, action, arg) }
  const usedBy = s.usedBy ?? []
  const showTools = (hover || menu) && !dim
  return (
    <div className={`fl-server${live ? ' fl-node-live' : ''}`} data-state={st} data-readable={s.readable} data-kind={isTcp ? 'TCP' : 'HTTP'} data-selected={selected ? 'true' : undefined} data-dim={dim ? 'true' : undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...serverBox, borderColor: st === 'fail' ? 'var(--fl-fail)' : st === 'on' ? `color-mix(in srgb, ${kindColor} 45%, var(--fl-border))` : 'var(--fl-border)', borderStyle: st === 'off' ? 'dashed' : 'solid', borderLeft: `4px solid ${color}`,
        opacity: dim ? 0.18 : st === 'off' ? 0.62 : 1, filter: dim ? 'grayscale(1)' : undefined, cursor: s.readable || selectMode ? 'pointer' : 'not-allowed',
        boxShadow: selected ? '0 0 0 2.5px var(--fl-primary), var(--fl-shadow)' : 'var(--fl-shadow)' }}>
      <Handle id="l" type="target" position={Position.Left} style={hiddenHandle} />
      <Handle id="r" type="target" position={Position.Right} style={hiddenHandle} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {selectMode && <input type="checkbox" checked={!!selected} readOnly aria-label={`${s.name} 선택`} style={{ width: 14, height: 14, accentColor: 'var(--fl-primary)', margin: 0, pointerEvents: 'none' }} />}
        <span className={live ? 'fl-led-live' : undefined} style={{ ...led, background: ledColor }} aria-label={`상태 ${stateLabel}`} />
        {fav && <span aria-label="즐겨찾기" style={{ color: 'var(--fl-put, #f5a623)', fontSize: 11 }}>★</span>}
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 800, fontSize: 13, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{s.name}</span>
        <span style={{ ...kindTag, color: kindColor }}>{isTcp ? 'TCP' : 'HTTP'}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: st === 'off' ? 'var(--fl-text-muted)' : ledColor, whiteSpace: 'nowrap' }}>{stateLabel}</span>
        {readOnly && <span style={{ fontSize: 11 }} title={!s.readable ? '접근 권한 없음' : '읽기 전용'}>🔒</span>}
        {st !== 'fail' && s.unmatchedRequests > 0 && <span style={badge} title="규칙에 안 맞은 요청">?</span>}
        {st === 'fail' && <span style={{ ...badge, background: 'var(--fl-fail)' }} title={s.listenError ?? '바인딩 실패'}>!</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span className="fl-port" style={{ ...mono, fontSize: 19, fontWeight: 800, color: st === 'off' ? 'var(--fl-text-muted)' : kindColor, letterSpacing: '-.01em', flexShrink: 0 }}>{port}</span>
        <span style={{ ...mono, fontSize: 11.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{tail}</span>
      </div>
      <div style={{ ...mono, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {summary} · {s.lastRequestAt ? `요청 ${relTime(s.lastRequestAt)}` : '요청 없음'}{live ? ` · ● ${s.recentRequests}건/60초` : ''}{usedBy.length > 0 ? ` · ↗${usedBy.length}` : ''}{s.currentVersion > 0 ? ` · v${s.currentVersion}` : ''}
      </div>
      {/* 도구 — 호버 시 우상단: ⏻ 켜기/끄기 · ⋯ 메뉴(목록이 하던 작업) */}
      {showTools && s.readable && (
        <div ref={menuRef} className="nodrag nopan" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} style={tools}>
          {editable && (
            <button onClick={() => act('toggle')} aria-label={`${s.name} ${s.enabled ? '끄기' : '켜기'}`} title={s.enabled ? '끄기' : '켜기'}
              style={{ ...toolBtn, color: s.enabled ? 'var(--fl-ok)' : 'var(--fl-text-muted)' }}>⏻</button>
          )}
          <button onClick={() => setMenu((v) => !v)} aria-label={`${s.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu} title="작업" style={toolBtn}>⋯</button>
          {menu && (
            <div role="menu" style={{ ...menuBox, ...(side === 'right' ? { right: 0 } : { left: 0 }) }}>
              <button role="menuitem" style={menuItem} onClick={() => act('fav')}>{fav ? '☆ 즐겨찾기 해제' : '★ 즐겨찾기'}</button>
              {!isTcp && <button role="menuitem" style={menuItem} onClick={() => act('copyUrl')}>⧉ base URL 복사</button>}
              {editable && <button role="menuitem" style={menuItem} onClick={() => act('toggle')}>{s.enabled ? '○ 끄기' : '● 켜기'}</button>}
              {editable && <button role="menuitem" style={menuItem} onClick={() => act('rename')}>✎ 이름 바꾸기</button>}
              {editable && <button role="menuitem" style={menuItem} onClick={() => act('duplicate')}>⧉ 복제</button>}
              <button role="menuitem" style={menuItem} onClick={() => act('export')}>⬆ 내보내기</button>
              {usedBy.length > 0 && (
                <>
                  <button role="menuitem" style={menuItem} onClick={() => setFlows((v) => !v)} aria-expanded={flows}>↗ 워크플로 {usedBy.length}{flows ? ' ▴' : ' ▾'}</button>
                  {flows && usedBy.map((f) => <button key={f.id} role="menuitem" style={{ ...menuItem, paddingLeft: 22, fontSize: 12 }} onClick={() => act('goFlow', f.id)}>↗ {f.name}</button>)}
                </>
              )}
              {editable && wsOptions.length > 1 && (
                <>
                  <div style={{ padding: '6px 10px 4px', fontSize: 11, color: 'var(--fl-text-muted)' }}>워크스페이스로 이동</div>
                  <select aria-label="워크스페이스 이동" value={s.workspaceId} onChange={(e) => act('move', e.target.value)} style={menuSelect}>
                    {wsOptions.map((w) => <option key={w.id} value={w.id}>{w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'} {w.name}</option>)}
                  </select>
                </>
              )}
              {editable && <button role="menuitem" style={{ ...menuItem, color: 'var(--fl-fail)' }} onClick={() => act('delete')}>🗑 삭제</button>}
              {selectMode !== undefined && <button role="menuitem" style={menuItem} onClick={() => { setMenu(false); onToggleSelect?.(s) }}>{selected ? '☐ 선택 해제' : '☑ 선택'}</button>}
            </div>
          )}
        </div>
      )}
      {hover && !menu && !dim && (
        <div className="fl-server-card" role="tooltip" style={{ ...hoverCard, ...(side === 'right' ? { right: 'calc(100% + 8px)' } : { left: 'calc(100% + 8px)' }) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <b style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.name}</b>
            <span style={{ ...kindTag, color: kindColor }}>{isTcp ? 'TCP' : 'HTTP'}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: st === 'off' ? 'var(--fl-text-muted)' : ledColor, flexShrink: 0 }}>{stateLabel}</span>
          </div>
          {s.listenError && <div style={{ fontSize: 11, color: 'var(--fl-fail)' }}>{s.listenError}</div>}
          <div style={{ ...mono, fontSize: 11, color: 'var(--fl-text)', wordBreak: 'break-all' }}>{fullAddress}</div>
          {s.readable ? (
            isTcp ? <div style={{ ...mono, fontSize: 10.5 }}>요청 필드 {s.tcpFieldCount} · 규칙 {s.tcpRuleCount}{s.hasCodec ? ' · ◈ 코덱' : ''}{s.environment ? ` · 🔑 ${s.environment}` : ''}</div>
              : s.routeLabels.length > 0
                ? <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{s.routeLabels.slice(0, 8).map((l, i) => <span key={i} style={cardPill}>{l}</span>)}{s.routeCount > 8 && <span style={cardPill}>+{s.routeCount - 8}</span>}</div>
                : <div style={{ ...mono, fontSize: 10.5 }}>라우트 없음</div>
          ) : <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>🔒 접근 권한이 없는 워크스페이스 — 이름·포트·상태만 보입니다.</div>}
          <div style={{ ...mono, fontSize: 10.5 }}>
            {s.lastRequestAt ? `마지막 요청 ${relTime(s.lastRequestAt)} · 기록 ${s.requestCount}` : '요청 없음'}{s.unmatchedRequests > 0 ? ` · 무매칭 ${s.unmatchedRequests}` : ''}{s.currentVersion > 0 ? ` · v${s.currentVersion}` : ''}
          </div>
          {usedBy.length > 0 && <div style={{ ...mono, fontSize: 10.5 }}>↗ 워크플로: {usedBy.slice(0, 3).map((f) => f.name).join(', ')}{usedBy.length > 3 ? ` 외 ${usedBy.length - 3}` : ''}</div>}
          {s.readable && <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{readOnly ? '읽기 전용 — 클릭하면 열람' : '클릭하면 편집기로 · Ctrl+클릭=선택'}</div>}
        </div>
      )}
    </div>
  )
}

const NODE_TYPES = { fhub: HubNode, fzone: ZoneNode, fspine: SpineNode, fserver: ServerNode }
const EDGE_TYPES = { felbow: ElbowEdge }

// ---------- 스타일 ----------
const mono: CSSProperties = { fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)' }
const hiddenHandle: CSSProperties = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 'none', pointerEvents: 'none' }
const hub: CSSProperties = { width: HUB_W, padding: '12px 14px', border: '1.5px solid color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))', borderRadius: 12, background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow)', color: 'var(--fl-text)', boxSizing: 'border-box' }
const led: CSSProperties = { display: 'inline-block', width: 9, height: 9, borderRadius: 999, flexShrink: 0 }
const kindTag: CSSProperties = { fontSize: 9.5, fontWeight: 800, letterSpacing: '.05em', padding: '1px 6px', borderRadius: 999, border: '1px solid currentColor', lineHeight: 1.5, flexShrink: 0 }
const zone: CSSProperties = { width: '100%', height: '100%', border: '1.5px solid color-mix(in srgb, var(--fl-primary) 30%, var(--fl-border))', borderRadius: 14, position: 'relative', boxSizing: 'border-box' }
const zoneHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '11px 16px', minWidth: 0 }
const roleChip: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', whiteSpace: 'nowrap' }
const zoneBtn: CSSProperties = { marginLeft: 'auto', height: 24, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }
const serverBox: CSSProperties = { width: NODE_W, height: NODE_H, boxSizing: 'border-box', display: 'grid', gap: 4, alignContent: 'center', padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 10, background: 'var(--fl-surface)', position: 'relative', transition: 'opacity .15s, filter .15s' }
const badge: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: 999, background: 'var(--fl-put, #f5a623)', color: '#fff', fontSize: 10, fontWeight: 900, flexShrink: 0 }
const tools: CSSProperties = { position: 'absolute', top: 4, right: 4, display: 'flex', gap: 2, padding: 2, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 7, boxShadow: 'var(--fl-shadow)', zIndex: 5 }
const toolBtn: CSSProperties = { width: 24, height: 22, border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 13, borderRadius: 5, padding: 0 }
const menuBox: CSSProperties = { position: 'absolute', top: 26, width: 200, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', boxShadow: 'var(--fl-shadow-lg)', padding: 5, zIndex: 60, display: 'grid', gap: 2, textAlign: 'left' }
const menuItem: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 10px', border: 'none', background: 'transparent', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left', borderRadius: 6 }
const menuSelect: CSSProperties = { width: '100%', padding: '5px 8px', margin: '0 0 2px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12 }
const edgeLabel: CSSProperties = { fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, fontWeight: 700, padding: '1px 6px', borderRadius: 5, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', pointerEvents: 'none', whiteSpace: 'nowrap' }
const legend: CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--fl-text-muted)', background: 'color-mix(in srgb, var(--fl-surface) 88%, transparent)', border: '1px solid var(--fl-border)', borderRadius: 8, padding: '5px 10px', margin: 10 }
const dot: CSSProperties = { display: 'inline-block', width: 8, height: 8, borderRadius: 999, marginRight: 4, verticalAlign: 'middle' }
const hoverCard: CSSProperties = { position: 'absolute', top: 0, width: 260, display: 'grid', gap: 5, padding: '10px 12px', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 10, boxShadow: 'var(--fl-shadow-lg)', color: 'var(--fl-text)', fontSize: 11.5, textAlign: 'left', zIndex: 50, pointerEvents: 'none' }
const cardPill: CSSProperties = { fontSize: 10, fontFamily: 'var(--fl-font-mono)', padding: '1px 6px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', whiteSpace: 'nowrap' }
