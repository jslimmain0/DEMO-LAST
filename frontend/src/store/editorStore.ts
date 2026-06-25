import { addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { Connection, Edge, EdgeChange, Node, NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { FlowGraph, GraphNode, NodeType } from '../api/types'
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

  loadGraph: (flowId: string, name: string, graph: FlowGraph) => void
  getGraph: () => FlowGraph
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect: (conn: Connection) => void
  addNode: (type: NodeType, pos: { x: number; y: number }) => string
  updateNodeData: (id: string, patch: Partial<GraphNode>) => void
  selectNode: (id: string | null) => void
  deleteNode: (id: string) => void
  setName: (name: string) => void
  markSaved: () => void
  selectedNode: () => GraphNode | null
}

export const useEditorStore = create<EditorState>()((set, get) => ({
  flowId: null,
  flowName: '',
  nodes: [],
  edges: [],
  selectedId: null,
  dirty: false,

  loadGraph: (flowId, name, graph) => {
    const { nodes, edges } = toRF(graph)
    set({ flowId, flowName: name, nodes, edges, selectedId: null, dirty: false })
  },

  getGraph: () => fromRF(get().nodes, get().edges, get().flowName),

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
    }
    set({ edges: addEdge(edge, get().edges), dirty: true })
  },

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
}))
