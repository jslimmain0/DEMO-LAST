import { addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { Connection, Edge, EdgeChange, Node, NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { FlowGraph, GraphNode, NodeType, PaletteGroup } from '../api/types'
import { asGraphNode, fromRF, rfNodeType, toRF } from '../canvas/graphAdapter'
import { makeNode } from '../canvas/nodeFactory'
import { newId } from '../lib/ids'

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

  loadGraph: (flowId: string, name: string, graph: FlowGraph) => void
  importGraph: (graph: FlowGraph) => void
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
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  flowId: null,
  flowName: '',
  nodes: [],
  edges: [],
  selectedId: null,
  dirty: false,
  palette: [],
  waitingNodeId: null,

  loadGraph: (flowId, name, graph) => {
    const { nodes, edges } = toRF(graph)
    set({ flowId, flowName: name, nodes, edges, selectedId: null, dirty: false, palette: graph.palette ?? [] })
  },

  // 현재 플로우(flowId 유지)의 캔버스를 가져온 그래프로 교체. 저장 가능하도록 dirty=true.
  importGraph: (graph) => {
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
    })
  },

  getGraph: () => ({ ...fromRF(get().nodes, get().edges, get().flowName), palette: get().palette }),

  onNodesChange: (changes) => {
    let dirty = get().dirty
    let selectedId = get().selectedId
    for (const c of changes) {
      if (c.type === 'position' && c.dragging === false) dirty = true
      else if (c.type === 'remove' || c.type === 'add' || c.type === 'replace') dirty = true
      else if (c.type === 'select') {
        if (c.selected) selectedId = c.id
        else if (selectedId === c.id) selectedId = null
      }
    }
    set({ nodes: applyNodeChanges(changes, get().nodes), dirty, selectedId })
  },

  onEdgesChange: (changes) => {
    const dirty = get().dirty || changes.some((c) => c.type === 'remove' || c.type === 'add')
    set({ edges: applyEdgeChanges(changes, get().edges), dirty })
  },

  onConnect: (conn) => {
    const edge: Edge = {
      id: 'e' + newId(),
      source: conn.source,
      target: conn.target,
      sourceHandle: conn.sourceHandle ?? 'out',
      type: 'deletable',
    }
    set({ edges: addEdge(edge, get().edges), dirty: true })
  },

  removeEdge: (id) => set({ edges: get().edges.filter((e) => e.id !== id), dirty: true }),

  addNode: (type, pos) => {
    const dn = makeNode(type, pos.x, pos.y)
    const rf: Node = {
      id: dn.id,
      type: rfNodeType(dn.type),
      position: { x: pos.x, y: pos.y },
      data: dn as unknown as Record<string, unknown>,
      selected: true,
    }
    set({
      nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), rf],
      selectedId: dn.id,
      dirty: true,
    })
    return dn.id
  },

  addNodeFromTemplate: (template, pos) => {
    const id = newId()
    const dn: GraphNode = { ...template, id, x: pos.x, y: pos.y }
    const rf: Node = {
      id,
      type: rfNodeType(dn.type),
      position: { x: pos.x, y: pos.y },
      data: dn as unknown as Record<string, unknown>,
      selected: true,
    }
    set({
      nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), rf],
      selectedId: id,
      dirty: true,
    })
    return id
  },

  updateNodeData: (id, patch) => {
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

  addPaletteGroup: (group) => set({ palette: [...get().palette, group], dirty: true }),
  removePaletteGroup: (groupId) => set({ palette: get().palette.filter((g) => g.id !== groupId), dirty: true }),
  removePaletteItem: (groupId, itemId) =>
    set({
      palette: get().palette
        .map((g) => (g.id === groupId ? { ...g, items: g.items.filter((it) => it.id !== itemId) } : g))
        .filter((g) => g.items.length > 0),
      dirty: true,
    }),
}))
