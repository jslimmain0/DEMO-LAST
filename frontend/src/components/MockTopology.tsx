import { Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react'
import type { Edge, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import type { MockFleet, MockFleetServer, MockFleetWorkspace } from '../api/types'
import { mockBaseUrl } from '../api/client'
import { relTime } from '../lib/format'

/**
 * Mock 서버 토폴로지 맵 — 캔버스(React Flow) 위에 **서버마다 컴퓨터(서버 타워)가 서 있고** 네트워크 → HTTP 게이트웨이 → HTTP 서버,
 * 네트워크 → TCP 서버(포트 라벨)로 선이 이어진다. 워크스페이스는 존(영역)으로 묶이고(내 소속 먼저, 남의 것은 🔒),
 * 켜짐/꺼짐/바인딩 실패는 전원 LED·선 색으로, 요청이 들어오면 활동 LED 가 깜빡이고 선이 흐른다. 팬/줌·미니맵·맞춤.
 * 위치는 데이터에서 계산(드래그 없음) — 5초 폴링마다 상태만 갱신.
 */
export function MockTopology({ fleet, host, tenant, onOpen, onOpenWorkspace, height = 560 }: {
  fleet: MockFleet
  host: string
  tenant?: string | null
  onOpen: (s: MockFleetServer) => void
  onOpenWorkspace: (wsId: string) => void
  height?: number
}) {
  const built = useMemo(() => buildGraph(fleet, host, tenant, onOpenWorkspace), [fleet, host, tenant, onOpenWorkspace])
  const [nodes, setNodes] = useNodesState<Node>(built.nodes)
  const [edges, setEdges] = useEdgesState<Edge>(built.edges)
  const inst = useRef<ReactFlowInstance<Node, Edge> | null>(null)
  const shapeRef = useRef('')
  useEffect(() => {
    setNodes(built.nodes); setEdges(built.edges)
    // 서버 집합/존 배치가 바뀌었을 때만 맞춤(상태 폴링마다 뷰가 튀지 않게)
    const shape = built.nodes.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join('|')
    if (shape !== shapeRef.current) { shapeRef.current = shape; setTimeout(() => inst.current?.fitView({ padding: 0.12, duration: 300 }), 30) }
  }, [built, setNodes, setEdges])
  return (
    <div className="fl-topology" aria-label="서버 토폴로지" style={{ height, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', overflow: 'hidden', position: 'relative' }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onInit={(i) => { inst.current = i; i.fitView({ padding: 0.12 }) }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnScroll zoomOnDoubleClick={false} minZoom={0.25} maxZoom={1.8}
        proOptions={{ hideAttribution: true }} fitView
        onNodeClick={(_, n) => { const s = (n.data as { server?: MockFleetServer }).server; if (s && s.readable) onOpen(s) }}>
        <Background gap={22} color="var(--fl-border)" />
        <MiniMap pannable zoomable nodeStrokeWidth={2} nodeColor={(n) => {
          const s = (n.data as { server?: MockFleetServer }).server
          if (!s) return n.type === 'fzone' ? 'transparent' : 'var(--fl-text-muted)'
          return machineState(s) === 'on' ? 'var(--fl-ok)' : machineState(s) === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border)'
        }} style={{ background: 'var(--fl-surface-2)' }} />
        <Controls showInteractive={false} />
        <Panel position="top-right" style={legend}>
          <span><i style={{ ...dot, background: 'var(--fl-ok)' }} /> 서빙 중 · 리스닝</span>
          <span><i style={{ ...dot, background: 'var(--fl-fail)' }} /> 바인딩 실패</span>
          <span><i style={{ ...dot, background: 'var(--fl-border-strong, var(--fl-border))' }} /> 꺼짐</span>
          <span><i style={{ width: 18, height: 0, borderTop: '2px dashed var(--fl-ok)', display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }} /> 요청 흐름</span>
          <span>🔒 읽기 전용</span>
        </Panel>
      </ReactFlow>
    </div>
  )
}

// ---------- 그래프 조립(위치 계산) ----------

const CELL_W = 172, CELL_H = 158, ZONE_PAD = 22, ZONE_HEAD = 46, MAX_COLS = 5, ROW_GAP = 44, COL_GAP = 40, MAX_ROW_W = 1360
export type MachineState = 'on' | 'off' | 'fail'
export function machineState(s: MockFleetServer): MachineState {
  return s.kind === 'TCP' ? (s.listening ? 'on' : s.listenError ? 'fail' : 'off') : (s.enabled ? 'on' : 'off')
}

function buildGraph(f: MockFleet, host: string, tenant: string | null | undefined, onOpenWorkspace: (id: string) => void): { nodes: Node[]; edges: Edge[] } {
  const byWs = new Map<string, MockFleetServer[]>()
  for (const s of f.servers) { const a = byWs.get(s.workspaceId) ?? []; a.push(s); byWs.set(s.workspaceId, a) }
  for (const a of byWs.values()) a.sort((x, y) => (x.kind === 'TCP' ? 1 : 0) - (y.kind === 'TCP' ? 1 : 0) || Number(y.enabled) - Number(x.enabled) || x.name.localeCompare(y.name, 'ko'))
  const rank = (w: MockFleetWorkspace) => (w.kind === 'PUBLIC' ? 0 : w.kind === 'PERSONAL' ? 1 : 2)
  const sorted = [...f.workspaces].sort((a, b) => Number(b.mine) - Number(a.mine) || rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'))
  const zones = sorted.filter((w) => w.mine || (byWs.get(w.id)?.length ?? 0) > 0)

  const nodes: Node[] = []
  const edges: Edge[] = []
  const anyHttpLive = f.servers.some((s) => s.kind !== 'TCP' && s.recentRequests > 0)
  const tcpOpen = f.ports.filter((p) => p.kind === 'TCP' && p.state === 'LISTENING').length
  nodes.push({ id: 'net', type: 'fnet', position: { x: 0, y: 0 }, data: { host, tcpOpen, tcpTotal: f.ports.filter((p) => p.kind === 'TCP').length }, draggable: false, selectable: false })
  nodes.push({ id: 'gw', type: 'fgw', position: { x: 300, y: 0 }, data: { port: f.httpPort, count: f.ports.find((p) => p.kind === 'HTTP')?.count ?? 0, contextPath: f.contextPath, live: anyHttpLive }, draggable: false, selectable: false })
  edges.push({ id: 'net-gw', source: 'net', sourceHandle: 'r', target: 'gw', targetHandle: 'l', type: 'smoothstep', animated: anyHttpLive, style: { stroke: 'var(--fl-ok)', strokeWidth: 2 } })

  // 존 배치 — 왼쪽부터 채우고 폭이 넘치면 다음 줄
  let x = 0, y = 150, rowH = 0
  for (const w of zones) {
    const servers = byWs.get(w.id) ?? []
    const n = servers.length
    const cols = Math.max(1, Math.min(MAX_COLS, n))
    const rows = Math.max(1, Math.ceil(n / cols))
    const zw = Math.max(360, ZONE_PAD * 2 + cols * CELL_W)
    const zh = ZONE_HEAD + ZONE_PAD + rows * CELL_H
    if (x > 0 && x + zw > MAX_ROW_W) { x = 0; y += rowH + ROW_GAP; rowH = 0 }
    const zid = `ws:${w.id}`
    nodes.push({ id: zid, type: 'fzone', position: { x, y }, data: { ws: w, count: n, on: servers.filter((s) => machineState(s) === 'on').length, live: servers.filter((s) => s.recentRequests > 0).length, onOpen: onOpenWorkspace }, style: { width: zw, height: zh }, zIndex: -1, draggable: false, selectable: false })
    servers.forEach((s, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const px = x + ZONE_PAD + col * CELL_W + (CELL_W - MACHINE_W) / 2
      const py = y + ZONE_HEAD + row * CELL_H
      nodes.push({ id: `m:${s.id}`, type: 'fmachine', position: { x: px, y: py }, data: { server: s, host, tenant }, draggable: false, selectable: false })
      const st = machineState(s)
      const live = s.recentRequests > 0
      const color = st === 'on' ? 'var(--fl-ok)' : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, var(--fl-border))'
      const isTcp = s.kind === 'TCP'
      edges.push({
        id: `e:${s.id}`, source: isTcp ? 'net' : 'gw', sourceHandle: isTcp ? 'b' : 'b', target: `m:${s.id}`, targetHandle: 't', type: 'smoothstep', animated: live,
        label: isTcp && s.tcpPort != null ? `:${s.tcpPort}` : undefined,
        labelStyle: { fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, fill: color, fontWeight: 700 },
        labelBgStyle: { fill: 'var(--fl-surface)', stroke: 'var(--fl-border)' }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
        style: { stroke: color, strokeWidth: live ? 2 : 1.4, strokeDasharray: st === 'off' ? '5 5' : undefined, opacity: st === 'off' ? 0.7 : 1 },
      })
    })
    x += zw + COL_GAP
    rowH = Math.max(rowH, zh)
  }
  return { nodes, edges }
}

// ---------- 노드 컴포넌트 ----------

const MACHINE_W = 136

function NetNode({ data }: NodeProps) {
  const d = data as { host: string; tcpOpen: number; tcpTotal: number }
  return (
    <div style={{ ...appliance, borderColor: 'color-mix(in srgb, var(--fl-primary) 40%, var(--fl-border))' }} title="사내망 — 이 호스트에서 열려 있는 포트들">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SwitchGlyph />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 12.5 }}>네트워크</div>
          <div style={{ ...mono, fontSize: 11.5, color: 'var(--fl-text)' }}>{d.host}</div>
        </div>
      </div>
      <div style={{ ...mono, fontSize: 10.5, marginTop: 6 }}>TCP 포트 {d.tcpOpen}/{d.tcpTotal} 열림</div>
      <Handle id="r" type="source" position={Position.Right} style={hiddenHandle} />
      <Handle id="b" type="source" position={Position.Bottom} style={hiddenHandle} />
    </div>
  )
}

function GatewayNode({ data }: NodeProps) {
  const d = data as { port: number; count: number; contextPath: string; live: boolean }
  return (
    <div style={{ ...appliance, borderColor: 'color-mix(in srgb, var(--fl-cat-http, var(--fl-primary)) 45%, var(--fl-border))' }} title={`모든 HTTP Mock 이 이 포트의 ${d.contextPath || ''}/mock/{slug}/** 로 서빙됩니다`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...led, width: 9, height: 9, background: 'var(--fl-ok)' }} className={d.live ? 'fl-led-live' : undefined} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 12.5 }}>HTTP 게이트웨이</div>
          <div style={{ ...mono, fontSize: 13, color: 'var(--fl-text)', fontWeight: 700 }}>:{d.port}<span style={{ fontWeight: 500, color: 'var(--fl-text-muted)' }}>{d.contextPath}/mock/…</span></div>
        </div>
      </div>
      <div style={{ ...mono, fontSize: 10.5, marginTop: 6 }}>{d.count}개 서빙 중</div>
      <Handle id="l" type="target" position={Position.Left} style={hiddenHandle} />
      <Handle id="b" type="source" position={Position.Bottom} style={hiddenHandle} />
    </div>
  )
}

function ZoneNode({ data }: NodeProps) {
  const d = data as { ws: MockFleetWorkspace; count: number; on: number; live: number; onOpen: (id: string) => void }
  const w = d.ws
  const icon = w.kind === 'PERSONAL' ? '🔒' : w.kind === 'TEAM' ? '👥' : '🌐'
  const readable = w.myRole != null
  const roleLabel = !readable ? '접근 없음' : w.myRole === 'VIEWER' ? '읽기 전용' : w.myRole === 'OWNER' ? (w.mine ? '소유' : '관리자') : '편집'
  const roleColor = !readable ? 'var(--fl-fail)' : w.myRole === 'VIEWER' ? 'var(--fl-put, #f5a623)' : 'var(--fl-ok)'
  return (
    <div style={{ ...zone, borderStyle: w.mine ? 'solid' : 'dashed', background: w.mine ? 'color-mix(in srgb, var(--fl-primary) 4%, transparent)' : 'color-mix(in srgb, var(--fl-text-muted) 6%, transparent)' }} data-mine={w.mine}>
      <div className="fl-zone-head nodrag nopan" style={zoneHead}>
        <span aria-hidden>{icon}</span>
        <span style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 800, fontSize: 13.5, color: 'var(--fl-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</span>
        <span style={{ ...roleChip, color: roleColor, borderColor: `color-mix(in srgb, ${roleColor} 40%, var(--fl-border))` }}>{(!readable || w.myRole === 'VIEWER') && '🔒 '}{roleLabel}</span>
        <span style={{ ...mono, fontSize: 10.5 }}>서버 {d.count} · 서빙 {d.on}{d.live ? ` · 요청 중 ${d.live}` : ''}</span>
        {readable && <button onClick={(e) => { e.stopPropagation(); d.onOpen(w.id) }} style={zoneBtn} title="이 워크스페이스의 목록 보기">목록으로 →</button>}
      </div>
      {d.count === 0 && <div style={{ ...mono, position: 'absolute', left: ZONE_PAD, top: ZONE_HEAD + 30, fontSize: 11.5 }}>이 워크스페이스에는 아직 Mock 서버가 없습니다.</div>}
    </div>
  )
}

function MachineNode({ data }: NodeProps) {
  const { server: s, host, tenant } = data as { server: MockFleetServer; host: string; tenant?: string | null }
  const st = machineState(s)
  const isTcp = s.kind === 'TCP'
  const live = s.recentRequests > 0
  const kindColor = isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-http, var(--fl-primary))'
  const ledColor = st === 'on' ? 'var(--fl-ok)' : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, #9aa0b2)'
  const readOnly = !s.readable || s.myRole === 'VIEWER'
  const address = isTcp ? `${host}:${s.tcpPort ?? '?'}` : mockBaseUrl(s.slug, tenant).replace(/^https?:\/\/[^/]+/, '')
  const stateLabel = isTcp ? (st === 'on' ? '리스닝' : st === 'fail' ? '바인딩 실패' : '꺼짐') : (st === 'on' ? '서빙 중' : '꺼짐')
  const summary = !s.readable ? (isTcp ? `규칙 ${s.tcpRuleCount}` : `라우트 ${s.routeCount}`) + ' · 정의 비공개'
    : isTcp ? `필드 ${s.tcpFieldCount} · 규칙 ${s.tcpRuleCount}${s.hasCodec ? ' · ◈' : ''}` : `라우트 ${s.routeCount}${s.hasCodec ? ' · ◈' : ''}${s.environment ? ` · 🔑${s.environment}` : ''}`
  const title = [
    `${s.name} — ${isTcp ? 'TCP' : 'HTTP'} · ${stateLabel}${s.listenError ? ` (${s.listenError})` : ''}`,
    isTcp ? `${host}:${s.tcpPort ?? '?'}` : mockBaseUrl(s.slug, tenant),
    s.readable ? (s.routeLabels.length ? s.routeLabels.join(' · ') : summary) : '접근 권한이 없는 워크스페이스 — 이름·포트·상태만',
    s.lastRequestAt ? `마지막 요청 ${relTime(s.lastRequestAt)} · 기록 ${s.requestCount}${s.unmatchedRequests ? ` · 무매칭 ${s.unmatchedRequests}` : ''}` : '요청 없음',
    s.currentVersion ? `v${s.currentVersion}` : '',
    s.readable ? (readOnly ? '읽기 전용 — 클릭하면 열람' : '클릭하면 편집기') : '',
  ].filter(Boolean).join('\n')
  return (
    <div className="fl-machine" data-state={st} data-readable={s.readable} data-kind={isTcp ? 'TCP' : 'HTTP'} title={title}
      style={{ width: MACHINE_W, display: 'grid', justifyItems: 'center', gap: 3, cursor: s.readable ? 'pointer' : 'not-allowed', opacity: st === 'off' ? 0.62 : 1 }}>
      <Handle id="t" type="target" position={Position.Top} style={hiddenHandle} />
      <Tower kindColor={kindColor} ledColor={ledColor} live={live} isTcp={isTcp} port={s.tcpPort ?? null} fail={st === 'fail'} lock={readOnly} unmatched={s.unmatchedRequests > 0} />
      <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 12.5, color: 'var(--fl-text)', maxWidth: MACHINE_W, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{s.name}</div>
      <div style={{ ...mono, fontSize: 10.5, color: 'var(--fl-text)', maxWidth: MACHINE_W, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</div>
      <div style={{ ...mono, fontSize: 10, display: 'flex', gap: 5, alignItems: 'center' }}>
        <span style={{ color: st === 'off' ? 'var(--fl-text-muted)' : ledColor, fontWeight: 700 }}>{stateLabel}</span>
        <span>· {summary}</span>
      </div>
    </div>
  )
}

/** 서버 타워 일러스트 — 전원 LED(상태)·활동 LED(트래픽 깜빡임)·종류 라벨·TCP 포트 잭. */
function Tower({ kindColor, ledColor, live, isTcp, port, fail, lock, unmatched }: { kindColor: string; ledColor: string; live: boolean; isTcp: boolean; port: number | null; fail: boolean; lock: boolean; unmatched: boolean }) {
  return (
    <svg width={76} height={92} viewBox="0 0 76 92" aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <filter id="fl-led-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6" /></filter>
      </defs>
      {/* 본체 */}
      <rect x={10} y={3} width={56} height={86} rx={6} fill="var(--fl-surface-2)" stroke="var(--fl-border-strong, var(--fl-border))" strokeWidth={1.4} />
      <rect x={10} y={3} width={56} height={86} rx={6} fill="none" stroke={kindColor} strokeWidth={1} opacity={0.5} />
      {/* 상단 라벨 스트립(종류) */}
      <rect x={16} y={9} width={44} height={12} rx={2.5} fill={kindColor} opacity={0.14} />
      <text x={38} y={18} textAnchor="middle" fontSize={8.5} fontWeight={800} fill={kindColor} fontFamily="var(--fl-font-mono)" letterSpacing=".06em">{isTcp ? 'TCP' : 'HTTP'}</text>
      {/* 전원 LED */}
      <circle cx={56} cy={15} r={5} fill={ledColor} opacity={0.35} filter="url(#fl-led-glow)" />
      <circle cx={56} cy={15} r={2.6} fill={ledColor} className={live ? 'fl-led-live' : undefined} />
      {/* 드라이브 베이 + 활동 LED */}
      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect x={16} y={27 + i * 14} width={44} height={10} rx={2} fill="var(--fl-surface)" stroke="var(--fl-border)" strokeWidth={1} />
          <rect x={20} y={31 + i * 14} width={22} height={2} rx={1} fill="var(--fl-border)" />
          <circle cx={54} cy={32 + i * 14} r={1.9} fill={live ? 'var(--fl-ok)' : 'var(--fl-border)'} className={live ? 'fl-blink' : undefined} style={{ animationDelay: `${i * 0.33}s` }} />
        </g>
      ))}
      {/* 하단: TCP 포트 잭 / HTTP 통풍구 */}
      {isTcp ? (
        <g>
          <rect x={20} y={72} width={36} height={12} rx={2.5} fill="var(--fl-surface)" stroke={ledColor} strokeWidth={1.4} />
          <text x={38} y={81} textAnchor="middle" fontSize={8} fontWeight={800} fill={ledColor} fontFamily="var(--fl-font-mono)">{port != null ? `:${port}` : '—'}</text>
        </g>
      ) : (
        <g stroke="var(--fl-border)" strokeWidth={1.2}>
          {[0, 1, 2, 3].map((i) => <line key={i} x1={20 + i * 10} y1={73} x2={20 + i * 10} y2={83} />)}
        </g>
      )}
      {/* 배지 — 바인딩 실패 / 무매칭 / 읽기 전용 */}
      {fail && <g><circle cx={12} cy={8} r={7} fill="var(--fl-fail)" /><text x={12} y={11} textAnchor="middle" fontSize={9} fontWeight={900} fill="#fff">!</text></g>}
      {!fail && unmatched && <g><circle cx={12} cy={8} r={6.5} fill="var(--fl-put, #f5a623)" /><text x={12} y={11} textAnchor="middle" fontSize={8.5} fontWeight={900} fill="#fff">?</text></g>}
      {lock && <text x={66} y={90} textAnchor="middle" fontSize={11}>🔒</text>}
    </svg>
  )
}

function SwitchGlyph() {
  return (
    <svg width={28} height={22} viewBox="0 0 28 22" aria-hidden>
      <rect x={1} y={5} width={26} height={12} rx={3} fill="var(--fl-surface-2)" stroke="var(--fl-primary)" strokeWidth={1.4} />
      {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={5 + i * 4.4} y={9} width={2.6} height={4} fill="var(--fl-primary)" opacity={0.8} />)}
    </svg>
  )
}

const NODE_TYPES = { fnet: NetNode, fgw: GatewayNode, fzone: ZoneNode, fmachine: MachineNode }

// ---------- 스타일 ----------
const mono: CSSProperties = { fontFamily: 'var(--fl-font-mono)', color: 'var(--fl-text-muted)' }
const hiddenHandle: CSSProperties = { opacity: 0, width: 6, height: 6, minWidth: 0, minHeight: 0, border: 'none', pointerEvents: 'none' }
const appliance: CSSProperties = { width: 230, padding: '10px 12px', border: '1.5px solid var(--fl-border)', borderRadius: 10, background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow)', color: 'var(--fl-text)' }
const led: CSSProperties = { display: 'inline-block', borderRadius: 999, flexShrink: 0 }
const zone: CSSProperties = { width: '100%', height: '100%', border: '1.5px solid color-mix(in srgb, var(--fl-primary) 30%, var(--fl-border))', borderRadius: 14, position: 'relative', boxSizing: 'border-box' }
const zoneHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', minWidth: 0 }
const roleChip: CSSProperties = { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', whiteSpace: 'nowrap' }
const zoneBtn: CSSProperties = { marginLeft: 'auto', height: 24, border: '1px solid var(--fl-border)', background: 'var(--fl-surface)', color: 'var(--fl-text)', padding: '0 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }
const legend: CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--fl-text-muted)', background: 'color-mix(in srgb, var(--fl-surface) 88%, transparent)', border: '1px solid var(--fl-border)', borderRadius: 8, padding: '5px 10px', margin: 10 }
const dot: CSSProperties = { display: 'inline-block', width: 8, height: 8, borderRadius: 999, marginRight: 4, verticalAlign: 'middle' }
