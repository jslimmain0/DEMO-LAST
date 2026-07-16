import { create } from 'zustand'

/** 원격 참여자 한 명 — editorStore 와 완전히 분리(dirty/undo/selected 불변). */
export interface Peer {
  id: string
  name: string
  color: string
  cursor: { x: number; y: number } | null
  editing: string | null
}

interface PresenceState {
  selfId: string | null
  peers: Record<string, Peer>
  hello: (id: string, peers: Peer[]) => void
  join: (peer: Peer) => void
  leave: (id: string) => void
  cursor: (id: string, x: number | null, y: number | null) => void
  editing: (id: string, nodeId: string | null) => void
  reset: () => void
}

export const usePresenceStore = create<PresenceState>((set) => ({
  selfId: null,
  peers: {},
  hello: (id, peers) =>
    set({ selfId: id, peers: Object.fromEntries(peers.map((p) => [p.id, p])) }),
  join: (peer) => set((s) => ({ peers: { ...s.peers, [peer.id]: peer } })),
  leave: (id) =>
    set((s) => {
      const peers = { ...s.peers }
      delete peers[id]
      return { peers }
    }),
  cursor: (id, x, y) =>
    set((s) => {
      const p = s.peers[id]
      if (!p) return s
      return { peers: { ...s.peers, [id]: { ...p, cursor: x == null || y == null ? null : { x, y } } } }
    }),
  editing: (id, nodeId) =>
    set((s) => {
      const p = s.peers[id]
      if (!p) return s
      return { peers: { ...s.peers, [id]: { ...p, editing: nodeId } } }
    }),
  reset: () => set({ selfId: null, peers: {} }),
}))
