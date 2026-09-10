import { Background, Controls, Handle, MiniMap, Panel, Position, ReactFlow, getNodesBounds, useEdgesState, useNodesState } from '@xyflow/react'
import type { Edge, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MockFleet, MockFleetServer, MockFleetWorkspace } from '../api/types'
import { mockBaseUrl } from '../api/client'
import { relTime } from '../lib/format'

/**
 * Mock 서버 토폴로지 맵 — 캔버스(React Flow) 위에 **서버마다 컴퓨터(서버 타워)가 서 있고** 네트워크 → HTTP 게이트웨이 → HTTP 서버,
 * 네트워크 → TCP 서버(포트 라벨)로 선이 이어진다. 워크스페이스는 존(영역)으로 묶이고(내 소속 먼저, 남의 것은 🔒),
 * 켜짐/꺼짐/바인딩 실패는 전원 LED·선 색으로, 요청이 들어오면 활동 LED 가 깜빡이고 선이 흐른다. 팬/줌·미니맵·맞춤.
 * 위치는 데이터에서 계산(드래그 없음) — 5초 폴링마다 상태만 갱신.
 */
export function MockTopology({ fleet, host, tenant, onOpen, onOpenWorkspace, height = 640 }: {
  fleet: MockFleet
  host: string
  tenant?: string | null
  onOpen: (s: MockFleetServer) => void
  onOpenWorkspace: (wsId: string) => void
  height?: number
}) {
  const built = useMemo(() => buildGraph(fleet, host, tenant, onOpenWorkspace), [fleet, host, tenant, onOpenWorkspace])
  // onNodesChange 를 꼭 넘겨야 측정(dimensions) 변경이 nodes 에 반영된다 — 없으면 미니맵이 노드를 못 그리고 bounds 도 0 크기
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(built.edges)
  const inst = useRef<ReactFlowInstance<Node, Edge> | null>(null)
  const shapeRef = useRef('')
  const wrapRef = useRef<HTMLDivElement>(null)
  /** 맞춤 — RF fitView 는 비동기(다음 프레임)라 뷰포트를 직접 계산: 다 들어가면 가운데, 줌 하한에 걸려 넘치면 왼쪽 위(네트워크·게이트웨이·첫 존)부터. */
  const fit = (i: ReactFlowInstance<Node, Edge> | null) => {
    const el = wrapRef.current
    if (!i || !el) return
    const b = getNodesBounds(i.getNodes())
    if (!(b.width > 0 && b.height > 0)) return
    const cw = el.clientWidth, ch = el.clientHeight, pad = 28
    const z = Math.min(FIT.maxZoom, Math.max(FIT.minZoom, Math.min((cw - pad * 2) / b.width, (ch - pad * 2) / b.height)))
    const fits = b.width * z <= cw - pad * 2 && b.height * z <= ch - pad * 2
    void i.setViewport({
      x: (fits ? (cw - b.width * z) / 2 : pad) - b.x * z,
      y: (fits ? (ch - b.height * z) / 2 : 18) - b.y * z,
      zoom: z,
    })
  }
  useEffect(() => {
    setNodes(built.nodes); setEdges(built.edges)
    // 서버 집합/존 배치가 바뀌었을 때만 맞춤(상태 폴링마다 뷰가 튀지 않게)
    const shape = built.nodes.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join('|')
    if (shape !== shapeRef.current) { shapeRef.current = shape; setTimeout(() => fit(inst.current), 60) }
  }, [built, setNodes, setEdges])
  return (
    <div ref={wrapRef} className="fl-topology" aria-label="서버 토폴로지" style={{ height, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)', overflow: 'hidden', position: 'relative' }}>
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={NODE_TYPES} onInit={(i) => { inst.current = i; setTimeout(() => fit(i), 60) }}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnScroll zoomOnDoubleClick={false} minZoom={0.25} maxZoom={1.8}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => { const s = (n.data as { server?: MockFleetServer }).server; if (s && s.readable) onOpen(s) }}>
        <Background gap={22} color="var(--fl-border)" />
        <MiniMap pannable zoomable nodeStrokeWidth={0} nodeBorderRadius={4} maskColor="rgba(120,120,140,0.18)" nodeColor={(n) => {
          const s = (n.data as { server?: MockFleetServer }).server
          if (!s) return n.type === 'fzone' ? 'rgba(124,92,255,0.10)' : '#7c5cff'
          return machineState(s) === 'on' ? '#16a34a' : machineState(s) === 'fail' ? '#dc2626' : '#b4b8c8'
        }} style={{ background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 8 }} />
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

const CELL_W = 196, CELL_H = 212, ZONE_PAD = 22, ZONE_HEAD = 46, MAX_COLS = 5, ROW_GAP = 40, ZONE_X = 430 // 왼쪽 열(장비 230) + 거터 200(선·라벨)
/** 맞춤 줌 — 서버가 많아도 아이콘이 너무 작아지지 않게 하한(0.7)을 두고 넘치면 팬으로 본다. */
const FIT = { minZoom: 0.7, maxZoom: 1.05 }
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
  nodes.push({ id: 'gw', type: 'fgw', position: { x: 0, y: 128 }, data: { port: f.httpPort, count: f.ports.find((p) => p.kind === 'HTTP')?.count ?? 0, contextPath: f.contextPath, live: anyHttpLive }, draggable: false, selectable: false })
  edges.push({ id: 'net-gw', source: 'net', sourceHandle: 'b', target: 'gw', targetHandle: 't', type: 'smoothstep', animated: anyHttpLive, style: { stroke: 'var(--fl-ok)', strokeWidth: 2 } })

  // 존 배치 — 오른쪽 열에 세로로 쌓는다(선은 왼쪽 거터만 타므로 다른 존을 가로지르지 않음)
  const x = ZONE_X
  let y = 0
  for (const w of zones) {
    const servers = byWs.get(w.id) ?? []
    const n = servers.length
    const cols = Math.max(1, Math.min(MAX_COLS, n))
    const rows = Math.max(1, Math.ceil(n / cols))
    const zw = Math.max(360, ZONE_PAD * 2 + cols * CELL_W)
    const zh = n === 0 ? ZONE_HEAD + 46 : ZONE_HEAD + ZONE_PAD + rows * CELL_H
    const zid = `ws:${w.id}`
    nodes.push({ id: zid, type: 'fzone', position: { x, y }, data: { ws: w, count: n, on: servers.filter((s) => machineState(s) === 'on').length, live: servers.filter((s) => s.recentRequests > 0).length, onOpen: onOpenWorkspace }, style: { width: zw, height: zh }, zIndex: -1, draggable: false, selectable: false })
    servers.forEach((s, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const px = x + ZONE_PAD + col * CELL_W + (CELL_W - MACHINE_W) / 2
      const py = y + ZONE_HEAD + row * CELL_H
      nodes.push({ id: `m:${s.id}`, type: 'fmachine', position: { x: px, y: py }, data: { server: s, host, tenant, cardSide: col >= cols - 1 ? 'left' : 'right' }, draggable: false, selectable: false })
    })
    // 선은 존 단위 — 서버마다 그으면 아이콘을 가로질러 지저분하다. 서버별 포트/상태는 아이콘(포트 잭·LED)에 있다.
    const https = servers.filter((s) => s.kind !== 'TCP'), tcps = servers.filter((s) => s.kind === 'TCP')
    if (https.length) {
      const on = https.filter((s) => machineState(s) === 'on').length, live = https.some((s) => s.recentRequests > 0)
      const color = on ? 'var(--fl-ok)' : 'var(--fl-border-strong, var(--fl-border))'
      edges.push({ id: `eh:${w.id}`, source: 'gw', sourceHandle: 'r', target: zid, targetHandle: 'h', type: 'smoothstep', animated: live, label: `HTTP ×${on}${on < https.length ? `/${https.length}` : ''}`,
        labelStyle: { fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, fill: color, fontWeight: 700 }, labelBgStyle: { fill: 'var(--fl-surface)', stroke: 'var(--fl-border)' }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
        style: { stroke: color, strokeWidth: live ? 2.2 : 1.6, strokeDasharray: on ? undefined : '5 5' } })
    }
    if (tcps.length) {
      const open = tcps.filter((s) => s.listening), live = tcps.some((s) => s.recentRequests > 0), failed = tcps.some((s) => machineState(s) === 'fail')
      const color = failed ? 'var(--fl-fail)' : open.length ? 'var(--fl-ok)' : 'var(--fl-border-strong, var(--fl-border))'
      const ports = open.map((s) => s.tcpPort ?? 0).sort((a, b) => a - b).map((p) => `:${p}`)
      const label = open.length ? `TCP ${ports.slice(0, 2).join(' ')}${ports.length > 2 ? ` +${ports.length - 2}` : ''}` : failed ? 'TCP 바인딩 실패' : 'TCP 꺼짐'
      edges.push({ id: `et:${w.id}`, source: 'net', sourceHandle: 'r', target: zid, targetHandle: 't', type: 'smoothstep', animated: live, label,
        labelStyle: { fontFamily: 'var(--fl-font-mono)', fontSize: 10.5, fill: color, fontWeight: 700 }, labelBgStyle: { fill: 'var(--fl-surface)', stroke: 'var(--fl-border)' }, labelBgPadding: [4, 2], labelBgBorderRadius: 4,
        style: { stroke: color, strokeWidth: live ? 2.2 : 1.6, strokeDasharray: open.length ? undefined : '5 5' } })
    }
    y += zh + ROW_GAP
  }
  return { nodes, edges }
}

// ---------- 노드 컴포넌트 ----------

const MACHINE_W = 160

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
      <Handle id="t" type="target" position={Position.Top} style={hiddenHandle} />
      <Handle id="r" type="source" position={Position.Right} style={hiddenHandle} />
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
      {d.count === 0 && <div style={{ ...mono, position: 'absolute', left: ZONE_PAD, top: ZONE_HEAD + 14, fontSize: 11.5 }}>이 워크스페이스에는 아직 Mock 서버가 없습니다.</div>}
      <Handle id="h" type="target" position={Position.Left} style={{ ...hiddenHandle, top: '36%' }} />
      <Handle id="t" type="target" position={Position.Left} style={{ ...hiddenHandle, top: '64%' }} />
    </div>
  )
}

function MachineNode({ data }: NodeProps) {
  const { server: s, host, tenant, cardSide } = data as { server: MockFleetServer; host: string; tenant?: string | null; cardSide?: 'left' | 'right' }
  const [hover, setHover] = useState(false)
  const st = machineState(s)
  const isTcp = s.kind === 'TCP'
  const live = s.recentRequests > 0
  const kindColor = isTcp ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-cat-http, var(--fl-primary))'
  const ledColor = st === 'on' ? 'var(--fl-ok)' : st === 'fail' ? 'var(--fl-fail)' : 'var(--fl-border-strong, #9aa0b2)'
  const readOnly = !s.readable || s.myRole === 'VIEWER'
  const fullAddress = isTcp ? `${host}:${s.tcpPort ?? '?'}` : mockBaseUrl(s.slug, tenant)
  const address = isTcp ? fullAddress : fullAddress.replace(/^https?:\/\/[^/]+/, '')
  const stateLabel = isTcp ? (st === 'on' ? '리스닝' : st === 'fail' ? '바인딩 실패' : '꺼짐') : (st === 'on' ? '서빙 중' : '꺼짐')
  const summary = !s.readable ? (isTcp ? `규칙 ${s.tcpRuleCount}` : `라우트 ${s.routeCount}`) + ' · 정의 비공개'
    : isTcp ? `필드 ${s.tcpFieldCount} · 규칙 ${s.tcpRuleCount}${s.hasCodec ? ' · ◈' : ''}` : `라우트 ${s.routeCount}${s.hasCodec ? ' · ◈' : ''}${s.environment ? ` · 🔑${s.environment}` : ''}`
  return (
    <div className="fl-machine" data-state={st} data-readable={s.readable} data-kind={isTcp ? 'TCP' : 'HTTP'}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ width: MACHINE_W, display: 'grid', justifyItems: 'center', gap: 2, cursor: s.readable ? 'pointer' : 'not-allowed', opacity: st === 'off' ? 0.62 : 1, position: 'relative' }}>
      <Handle id="t" type="target" position={Position.Top} style={hiddenHandle} />
      <Tower kindColor={kindColor} ledColor={ledColor} state={st} live={live} isTcp={isTcp} port={s.tcpPort ?? null} lock={readOnly} unmatched={s.unmatchedRequests > 0} />
      <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 800, fontSize: 13.5, color: 'var(--fl-text)', maxWidth: MACHINE_W, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center', marginTop: 2 }}>{s.name}</div>
      <div style={{ ...mono, fontSize: 10.5, color: 'var(--fl-text)', maxWidth: MACHINE_W, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{address}</div>
      <div style={{ ...mono, fontSize: 10, display: 'flex', gap: 5, alignItems: 'center', maxWidth: MACHINE_W, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <span style={{ color: st === 'off' ? 'var(--fl-text-muted)' : ledColor, fontWeight: 700 }}>{stateLabel}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>· {summary}</span>
      </div>
      {hover && (
        <div className="fl-machine-card" role="tooltip" style={{ ...hoverCard, ...(cardSide === 'left' ? { right: 'calc(100% + 6px)' } : { left: 'calc(100% + 6px)' }) }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <b style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.name}</b>
            <span style={{ fontSize: 9.5, fontWeight: 800, color: kindColor, border: '1px solid currentColor', borderRadius: 999, padding: '0 6px', flexShrink: 0 }}>{isTcp ? 'TCP' : 'HTTP'}</span>
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
          {s.readable && <div style={{ fontSize: 10.5, color: 'var(--fl-text-muted)' }}>{readOnly ? '읽기 전용 — 클릭하면 열람' : '클릭하면 편집기로'}</div>}
        </div>
      )}
    </div>
  )
}

/**
 * 서버 아이콘 — 2.5D 랙 서버(윗면·옆면·앞면). 앞면: 종류 라벨 + 전원 LED(상태색·켜지면 광), 랙 유닛 3단(활동 LED=트래픽 깜빡임·통풍구·핸들),
 * 하단 베젤(TCP=RJ45 잭+포트 / HTTP=글로브). 바닥 그림자는 켜져 있으면 상태색으로 "떠 있는" 느낌. 배지 `!` 바인딩 실패 · `?` 무매칭 · 🔒.
 */
function Tower({ kindColor, ledColor, state, live, isTcp, port, lock, unmatched }: {
  kindColor: string; ledColor: string; state: MachineState; live: boolean; isTcp: boolean; port: number | null; lock: boolean; unmatched: boolean
}) {
  const on = state === 'on'
  return (
    <svg width={118} height={116} viewBox="0 0 118 116" aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <filter id="fl-led-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2" /></filter>
      </defs>
      {/* 바닥 그림자 — 켜져 있으면 상태색 광 */}
      <ellipse cx={58} cy={110} rx={42} ry={5} fill={on ? ledColor : 'var(--fl-text-muted)'} opacity={on ? 0.22 : 0.1} />
      {/* 2.5D 섀시: 옆면 · 윗면 · 앞면 */}
      <polygon points="92,18 104,8 104,96 92,106" fill="var(--fl-border-strong, #8b90a5)" opacity={0.7} />
      <polygon points="16,18 28,8 104,8 92,18" fill="var(--fl-surface)" stroke="var(--fl-border-strong, var(--fl-border))" strokeWidth={1} />
      <rect x={16} y={18} width={76} height={88} rx={3} fill="var(--fl-surface-2)" stroke="var(--fl-border-strong, var(--fl-border))" strokeWidth={1.4} />
      <rect x={16} y={18} width={76} height={88} rx={3} fill="none" stroke={kindColor} strokeWidth={1} opacity={0.45} />
      {/* 상단 베젤: 종류 라벨 + 전원 LED */}
      <rect x={21} y={23} width={42} height={11} rx={2} fill={kindColor} opacity={0.16} />
      <text x={42} y={31.5} textAnchor="middle" fontSize={8.5} fontWeight={800} fill={kindColor} fontFamily="var(--fl-font-mono)" letterSpacing=".08em">{isTcp ? 'TCP' : 'HTTP'}</text>
      <circle cx={82} cy={28.5} r={6} fill={ledColor} opacity={on ? 0.45 : 0.18} filter="url(#fl-led-glow)" />
      <circle cx={82} cy={28.5} r={3.2} fill={ledColor} className={live ? 'fl-led-live' : undefined} />
      {/* 랙 유닛 3단: 활동 LED · 통풍구 · 핸들 */}
      {[0, 1, 2].map((i) => {
        const y = 39 + i * 18
        return (
          <g key={i}>
            <rect x={21} y={y} width={66} height={15} rx={2} fill="var(--fl-surface)" stroke="var(--fl-border)" strokeWidth={1} />
            <circle cx={27} cy={y + 7.5} r={2.2} fill={live ? 'var(--fl-ok)' : on ? 'color-mix(in srgb, var(--fl-ok) 45%, var(--fl-border))' : 'var(--fl-border)'} className={live ? 'fl-blink' : undefined} style={{ animationDelay: `${i * 0.31}s` }} />
            {[0, 1, 2, 3, 4, 5].map((j) => <rect key={j} x={34 + j * 6.5} y={y + 3.5} width={3.2} height={8} rx={0.8} fill="var(--fl-border)" />)}
            <rect x={76} y={y + 3} width={7} height={9} rx={1.5} fill="none" stroke="var(--fl-border-strong, var(--fl-border))" strokeWidth={1.2} />
          </g>
        )
      })}
      {/* 하단 베젤: TCP=RJ45 잭+포트 / HTTP=글로브+web */}
      <rect x={21} y={94} width={66} height={9} rx={2} fill="var(--fl-surface)" stroke="var(--fl-border)" strokeWidth={1} />
      {isTcp ? (
        <g>
          <rect x={25} y={95.5} width={15} height={6} rx={1} fill="var(--fl-surface-2)" stroke={ledColor} strokeWidth={1.2} />
          <rect x={29} y={95.5} width={7} height={2.5} fill={ledColor} opacity={0.6} />
          <text x={64} y={101.3} textAnchor="middle" fontSize={8} fontWeight={800} fill={ledColor} fontFamily="var(--fl-font-mono)">{port != null ? `:${port}` : '—'}</text>
        </g>
      ) : (
        <g>
          <g stroke={kindColor} strokeWidth={1.1} fill="none"><circle cx={30} cy={98.5} r={3.4} /><ellipse cx={30} cy={98.5} rx={1.4} ry={3.4} /><line x1={26.6} y1={98.5} x2={33.4} y2={98.5} /></g>
          <text x={62} y={101.3} textAnchor="middle" fontSize={7.5} fontWeight={800} fill={kindColor} fontFamily="var(--fl-font-mono)" letterSpacing=".08em">/mock/…</text>
        </g>
      )}
      {/* 배지 — 바인딩 실패 / 무매칭 / 읽기 전용 */}
      {state === 'fail' && <g><circle cx={18} cy={12} r={7.5} fill="var(--fl-fail)" /><text x={18} y={15.5} textAnchor="middle" fontSize={10} fontWeight={900} fill="#fff">!</text></g>}
      {state !== 'fail' && unmatched && <g><circle cx={18} cy={12} r={7} fill="var(--fl-put, #f5a623)" /><text x={18} y={15.5} textAnchor="middle" fontSize={9.5} fontWeight={900} fill="#fff">?</text></g>}
      {lock && <text x={104} y={112} textAnchor="middle" fontSize={13}>🔒</text>}
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
const hoverCard: CSSProperties = { position: 'absolute', top: 0, width: 260, display: 'grid', gap: 5, padding: '10px 12px', background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 10, boxShadow: 'var(--fl-shadow-lg)', color: 'var(--fl-text)', fontSize: 11.5, textAlign: 'left', zIndex: 50, pointerEvents: 'none' }
const cardPill: CSSProperties = { fontSize: 10, fontFamily: 'var(--fl-font-mono)', padding: '1px 6px', borderRadius: 999, border: '1px solid var(--fl-border)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', whiteSpace: 'nowrap' }
const dot: CSSProperties = { display: 'inline-block', width: 8, height: 8, borderRadius: 999, marginRight: 4, verticalAlign: 'middle' }
