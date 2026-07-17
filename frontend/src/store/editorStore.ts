import { addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { Connection, Edge, EdgeChange, Node, NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { FlowGraph, GraphNode, NodeType, PaletteGroup } from '../api/types'
import { asGraphNode, fromRF, rfExtras, rfNodeType, toRF } from '../canvas/graphAdapter'
import { makeNode } from '../canvas/nodeFactory'
import { newId } from '../lib/ids'
import type { RunView } from '../lib/runProgress'

// D2: 고빈도 캔버스 상태(nodes/edges/selection)는 zustand 단일 진실원. react-query 서버상태와 분리.
interface EditorState {
  flowId: string | null
  flowName: string
  nodes: Node[]
  edges: Edge[]
  selectedId: string | null
  dirty: boolean
  palette: PaletteGroup[]
  // 실행 중 콜백을 기다리는 wait 노드(캔버스 펄스·유입 엣지 애니메이션용). 실행 상태라 dirty 와 무관.
  waitingNodeId: string | null
  // 실행 경과 표시(노드 상태·엣지 진행 애니메이션) — 폴링된 ExecutionDetail 로 계산. dirty 와 무관.
  runView: RunView | null
  // 실행취소/다시실행 스택(캔버스 스냅샷) — Ctrl+Z / Ctrl+Shift+Z
  past: Array<{ nodes: Node[]; edges: Edge[] }>
  future: Array<{ nodes: Node[]; edges: Edge[] }>

  loadGraph: (flowId: string, name: string, graph: FlowGraph) => void
  importGraph: (graph: FlowGraph) => void
  // 공동 편집 — 원격 참여자의 그래프 스냅샷을 적용(로컬 선택 하이라이트는 보존, 히스토리 미적재)
  applyRemoteGraph: (nodes: Node[], edges: Edge[]) => void
  getGraph: () => FlowGraph
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (conn: Connection) => void
  removeEdge: (id: string) => void
  addNode: (type: NodeType, pos: { x: number; y: number }) => string
  addNodeFromTemplate: (template: GraphNode, pos: { x: number; y: number }) => string
  updateNodeData: (id: string, patch: Partial<GraphNode>) => void
  selectNode: (id: string | null) => void
  deleteNode: (id: string) => void
  setName: (name: string) => void
  markSaved: () => void
  selectedNode: () => GraphNode | null
  addPaletteGroup: (group: PaletteGroup) => void
  removePaletteGroup: (groupId: string) => void
  removePaletteItem: (groupId: string, itemId: string) => void
  setWaitingNode: (id: string | null) => void
  setRunView: (view: RunView | null) => void
  // 노드 복사/붙여넣기 — localStorage 클립보드라 A 워크플로 → B 워크플로 붙여넣기도 된다
  copySelection: () => number
  pasteClipboard: () => number
  undo: () => void
  redo: () => void
}

// 노드 클립보드(localStorage) — 워크플로 간 이동/새로고침에도 유지된다.
const CLIP_KEY = 'fl:node-clipboard'

interface NodeClipboard {
  nodes: GraphNode[]
  edges: Array<{ from: string; to: string; fromPort?: string }>
}

/** 복사된 그룹 안의 토큰({{ key@구노드 }})/바인딩이 붙여넣은 새 id 를 가리키도록 재매핑. */
function remapNodeRefs(node: GraphNode, idMap: Map<string, string>): GraphNode {
  let s = JSON.stringify(node)
  for (const [oldId, newId] of idMap) {
    // 토큰 sourceId (@old / @req:old) — 뒤가 "}}" 로 닫힐 때만
    s = s.replace(new RegExp(`(@(?:req:)?)${oldId}(?=\\s*\\}\\})`, 'g'), `$1${newId}`)
    // 구조적 바인딩(bound.sourceId)
    s = s.replaceAll(`"sourceId":"${oldId}"`, `"sourceId":"${newId}"`)
  }
  return JSON.parse(s) as GraphNode
}

export const useEditorStore = create<EditorState>()((set, get) => {
  // --- 실행취소(undo/redo) 히스토리 — 캔버스(nodes/edges) 스냅샷. 갱신이 전부 불변식이라 얕은 참조로 안전 ---
  const HISTORY_MAX = 100
  let lastDataEdit: { nodeId: string; at: number } | null = null // 속성 타이핑 병합(연타를 한 항목으로)
  let dragInProgress = false // 드래그는 시작 시 1회만 스냅샷(중간 이동은 흘려보냄 → undo 는 드래그 전 위치로)
  const pushHistory = () => {
    lastDataEdit = null
    set({
      past: [...get().past.slice(-(HISTORY_MAX - 1)), { nodes: get().nodes, edges: get().edges }],
      future: [],
    })
  }

  return {
  flowId: null,
  flowName: '',
  nodes: [],
  edges: [],
  selectedId: null,
  dirty: false,
  palette: [],
  waitingNodeId: null,
  runView: null,
  past: [],
  future: [],

  loadGraph: (flowId, name, graph) => {
    const { nodes, edges } = toRF(graph)
    lastDataEdit = null
    dragInProgress = false
    set({ flowId, flowName: name, nodes, edges, selectedId: null, dirty: false, palette: graph.palette ?? [], runView: null, past: [], future: [] })
  },

  // 현재 플로우(flowId 유지)의 캔버스를 가져온 그래프로 교체. 저장 가능하도록 dirty=true.
  importGraph: (graph) => {
    pushHistory() // 가져오기 전 캔버스로 되돌릴 수 있게
    const { nodes, edges } = toRF(graph)
    // 양 끝 노드가 실제로 존재하는 엣지만 유지(가져온 그래프의 댕글링 엣지를 React Flow가 조용히 버리는 것 방지)
    const ids = new Set(nodes.map((n) => n.id))
    const cleanEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
    set({
      nodes,
      edges: cleanEdges,
      selectedId: null,
      dirty: true,
      flowName: graph.name && graph.name.trim() ? graph.name : get().flowName,
      palette: graph.palette ?? get().palette,
      runView: null,
    })
  },

  // 공동 편집 — 원격 스냅샷을 그대로 반영. 로컬 selectedId 하이라이트만 유지(내 선택은 안 뺏김),
  // dirty=true(받은 쪽도 저장 가능), 히스토리 미적재(내 undo 스택 오염 방지). 에코 방지는 collab 이 담당.
  applyRemoteGraph: (nodes, edges) => {
    const sel = get().selectedId
    set({
      nodes: nodes.map((n) => ({ ...n, selected: n.id === sel })),
      edges,
      dirty: true,
    })
  },

  getGraph: () => ({ ...fromRF(get().nodes, get().edges, get().flowName), palette: get().palette }),

  onNodesChange: (changes) => {
    // 드래그 시작 시 1회 스냅샷 · 삭제(Delete 키)도 스냅샷
    if (!dragInProgress && changes.some((c) => c.type === 'position' && c.dragging === true)) {
      pushHistory()
      dragInProgress = true
    }
    if (changes.some((c) => c.type === 'remove')) pushHistory()
    let dirty = get().dirty
    let selectedId = get().selectedId
    for (const c of changes) {
      if (c.type === 'position' && c.dragging === false) {
        dirty = true
        dragInProgress = false
      } else if (c.type === 'remove' || c.type === 'add' || c.type === 'replace') dirty = true
      else if (c.type === 'select') {
        if (c.selected) selectedId = c.id
        else if (selectedId === c.id) selectedId = null
      }
    }
    set({ nodes: applyNodeChanges(changes, get().nodes), dirty, selectedId })
  },

  onEdgesChange: (changes) => {
    if (changes.some((c) => c.type === 'remove')) pushHistory()
    const dirty = get().dirty || changes.some((c) => c.type === 'remove' || c.type === 'add')
    set({ edges: applyEdgeChanges(changes, get().edges), dirty })
  },

  onConnect: (conn) => {
    pushHistory()
    const edge: Edge = {
      id: 'e' + newId(),
      source: conn.source,
      target: conn.target,
      sourceHandle: conn.sourceHandle ?? 'out',
      type: 'deletable',
    }
    set({ edges: addEdge(edge, get().edges), dirty: true })
  },

  removeEdge: (id) => {
    pushHistory()
    set({ edges: get().edges.filter((e) => e.id !== id), dirty: true })
  },

  addNode: (type, pos) => {
    pushHistory()
    const dn = makeNode(type, pos.x, pos.y)
    const rf: Node = {
      id: dn.id,
      type: rfNodeType(dn.type),
      position: { x: pos.x, y: pos.y },
      data: dn as unknown as Record<string, unknown>,
      selected: true,
      ...rfExtras(dn.type),
    }
    set({
      nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), rf],
      selectedId: dn.id,
      dirty: true,
    })
    return dn.id
  },

  addNodeFromTemplate: (template, pos) => {
    pushHistory()
    const id = newId()
    const dn: GraphNode = { ...template, id, x: pos.x, y: pos.y }
    const rf: Node = {
      id,
      type: rfNodeType(dn.type),
      position: { x: pos.x, y: pos.y },
      data: dn as unknown as Record<string, unknown>,
      selected: true,
      ...rfExtras(dn.type),
    }
    set({
      nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), rf],
      selectedId: id,
      dirty: true,
    })
    return id
  },

  updateNodeData: (id, patch) => {
    // 속성 타이핑은 900ms 안의 같은 노드 연속 수정을 한 히스토리 항목으로 병합(키 입력마다 스택이 넘치지 않게)
    const now = Date.now()
    if (!lastDataEdit || lastDataEdit.nodeId !== id || now - lastDataEdit.at > 900) {
      pushHistory()
    }
    lastDataEdit = { nodeId: id, at: now }
    set({
      nodes: get().nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } as Record<string, unknown> } : n,
      ),
      dirty: true,
    })
  },

  selectNode: (id) => {
    set({
      selectedId: id,
      nodes: get().nodes.map((n) => ({ ...n, selected: n.id === id })),
    })
  },

  deleteNode: (id) => {
    pushHistory()
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedId: get().selectedId === id ? null : get().selectedId,
      dirty: true,
    })
  },

  setName: (name) => set({ flowName: name, dirty: true }),
  markSaved: () => set({ dirty: false }),
  selectedNode: () => {
    const id = get().selectedId
    if (!id) return null
    const n = get().nodes.find((x) => x.id === id)
    return n ? asGraphNode(n.data) : null
  },

  setWaitingNode: (id) => set({ waitingNodeId: id }),
  setRunView: (view) => set({ runView: view }),

  copySelection: () => {
    const selected = get().nodes.filter((n) => n.selected)
    const picked = selected.length > 0 ? selected : get().nodes.filter((n) => n.id === get().selectedId)
    if (picked.length === 0) return 0
    const ids = new Set(picked.map((n) => n.id))
    const clip: NodeClipboard = {
      nodes: picked.map((n) => ({ ...asGraphNode(n.data), id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
      // 복사된 노드들 사이의 연결만 함께(그룹 복사)
      edges: get().edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ from: e.source, to: e.target, fromPort: e.sourceHandle ?? 'out' })),
    }
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(clip))
    } catch {
      return 0
    }
    return picked.length
  },

  pasteClipboard: () => {
    let clip: NodeClipboard | null = null
    try {
      const raw = localStorage.getItem(CLIP_KEY)
      clip = raw ? (JSON.parse(raw) as NodeClipboard) : null
    } catch {
      clip = null
    }
    if (!clip || !Array.isArray(clip.nodes) || clip.nodes.length === 0) return 0
    pushHistory()
    const idMap = new Map<string, string>()
    for (const n of clip.nodes) idMap.set(n.id, newId())
    const rfNodes: Node[] = clip.nodes.map((gn) => {
      const remapped = remapNodeRefs(gn, idMap)
      const nid = idMap.get(gn.id)!
      const pos = { x: (gn.x ?? 0) + 44, y: (gn.y ?? 0) + 44 } // 그리드(22) 배수만큼 어긋나게 — 겹침 방지 + 스냅 유지
      return {
        id: nid,
        type: rfNodeType(remapped.type),
        position: pos,
        data: { ...remapped, id: nid, x: pos.x, y: pos.y } as unknown as Record<string, unknown>,
        selected: true,
        ...rfExtras(remapped.type),
      }
    })
    const rfEdges: Edge[] = clip.edges
      .filter((e) => idMap.has(e.from) && idMap.has(e.to))
      .map((e) => ({
        id: 'e' + newId(),
        source: idMap.get(e.from)!,
        target: idMap.get(e.to)!,
        sourceHandle: e.fromPort ?? 'out',
        type: 'deletable',
      }))
    set({
      nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...rfNodes],
      edges: [...get().edges, ...rfEdges],
      selectedId: rfNodes[0]?.id ?? get().selectedId,
      dirty: true,
    })
    return rfNodes.length
  },

  undo: () => {
    const past = get().past
    if (past.length === 0) return
    const cur = { nodes: get().nodes, edges: get().edges }
    const prev = past[past.length - 1]
    lastDataEdit = null
    dragInProgress = false
    const ids = new Set(prev.nodes.map((n) => n.id))
    const sel = get().selectedId
    set({
      past: past.slice(0, -1),
      future: [...get().future.slice(-(HISTORY_MAX - 1)), cur],
      nodes: prev.nodes,
      edges: prev.edges,
      selectedId: sel && ids.has(sel) ? sel : null,
      dirty: true,
    })
  },

  redo: () => {
    const future = get().future
    if (future.length === 0) return
    const cur = { nodes: get().nodes, edges: get().edges }
    const next = future[future.length - 1]
    lastDataEdit = null
    dragInProgress = false
    const ids = new Set(next.nodes.map((n) => n.id))
    const sel = get().selectedId
    set({
      future: future.slice(0, -1),
      past: [...get().past.slice(-(HISTORY_MAX - 1)), cur],
      nodes: next.nodes,
      edges: next.edges,
      selectedId: sel && ids.has(sel) ? sel : null,
      dirty: true,
    })
  },

  addPaletteGroup: (group) => set({ palette: [...get().palette, group], dirty: true }),
  removePaletteGroup: (groupId) => set({ palette: get().palette.filter((g) => g.id !== groupId), dirty: true }),
  removePaletteItem: (groupId, itemId) =>
    set({
      palette: get().palette
        .map((g) => (g.id === groupId ? { ...g, items: g.items.filter((it) => it.id !== itemId) } : g))
        .filter((g) => g.items.length > 0),
      dirty: true,
    }),
  }
})
