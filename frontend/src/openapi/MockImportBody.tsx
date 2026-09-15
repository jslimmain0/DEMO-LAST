// frontend/src/openapi/MockImportBody.tsx — Mock 서버 규격을 팔레트 템플릿으로: HTTP 는 라우트마다 HTTP 노드, TCP 는 요청 전문마다 TCP 노드
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { GraphNode, HttpMethod, PaletteGroup } from '../api/types'
import { mockBaseUrl, mocksApi, protocolsApi } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { makeNode } from '../canvas/nodeFactory'
import { newId } from '../lib/ids'
import { apiErrorMessage } from '../lib/apiError'
import { requestKeys } from '../lib/protocolSpec'

export function MockImportBody({ onImport, onClose }: { onImport: (g: PaletteGroup) => void; onClose: () => void }) {
  const fleet = useQuery({ queryKey: ['mock-fleet'], queryFn: mocksApi.fleet })
  const { me } = useAuth()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const servers = (fleet.data?.servers ?? []).filter((s) => s.readable && (!q || `${s.name} ${s.slug}`.toLowerCase().includes(q.toLowerCase())))

  const pick = async (id: string) => {
    setBusy(id); setErr(null)
    try {
      const d = await mocksApi.get(id)
      const items: PaletteGroup['items'] = []
      if (d.kind === 'TCP' || d.spec?.tcp) {
        const tcp = d.spec?.tcp
        if (!tcp?.protocolId) throw new Error('이 TCP Mock 은 아직 프로토콜이 없습니다.')
        const p = await protocolsApi.get(tcp.protocolId)
        for (const m of requestKeys(p.spec)) {
          const node: GraphNode = { ...makeNode('tcp', 0, 0), id: newId(), name: `${m.key}${p.spec.messages.find((x) => x.key === m.key)?.label ? ' ' + p.spec.messages.find((x) => x.key === m.key)!.label : ''}`,
            tcpHost: window.location.hostname || 'localhost', tcpPort: tcp.port ?? 0, tcpTimeoutMs: tcp.timeoutMs ?? 5000, protocolId: tcp.protocolId, tcpMessage: m.key, tcpValues: {}, tcpResponseMessage: '' }
          items.push({ id: newId(), label: node.name!, path: `:${tcp.port} ${m.key}`, node })
        }
      } else {
        const base = mockBaseUrl(d.slug, me?.tenant)
        for (const r of d.spec?.routes ?? []) {
          const method = ((r.method ?? 'GET').toUpperCase() === 'ANY' ? 'GET' : (r.method ?? 'GET').toUpperCase()) as HttpMethod
          const node: GraphNode = { ...makeNode('http', 0, 0), id: newId(), name: `${method} ${r.path ?? '/'}`, method, baseUrl: base + (r.path ?? ''), path: '' }
          items.push({ id: newId(), label: node.name!, method, path: r.path ?? '/', node })
        }
      }
      if (items.length === 0) throw new Error('가져올 라우트/전문이 없습니다.')
      onImport({ id: newId(), title: `Mock: ${d.name}`, items })
      onClose()
    } catch (e) { setErr(e instanceof Error ? e.message : apiErrorMessage(e)) } finally { setBusy(null) }
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <p style={{ fontSize: 12, color: 'var(--fl-text-muted)', margin: 0 }}>Mock 서버의 규격을 팔레트에 담습니다 — HTTP Mock 은 라우트마다 HTTP 노드, TCP Mock 은 요청 전문마다 TCP 노드(프로토콜 연결됨).</p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름/slug 검색" autoFocus style={{ padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)' }} />
      {err && <div style={{ fontSize: 12, color: 'var(--fl-fail)' }}>{err}</div>}
      <div style={{ maxHeight: 360, overflow: 'auto', display: 'grid', gap: 4 }}>
        {servers.map((s) => (
          <button key={s.id} disabled={busy != null} onClick={() => void pick(s.id)} style={{ display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', padding: '8px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer' }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: 'var(--fl-font-mono)', color: s.kind === 'TCP' ? 'var(--fl-cat-tcp, #7c5cff)' : 'var(--fl-primary)' }}>{s.kind === 'TCP' ? 'TCP' : 'HTTP'}</span>
            <span style={{ flex: 1, fontWeight: 600 }}>{s.name}</span>
            <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{s.kind === 'TCP' ? `:${s.tcpPort ?? '?'} · ${s.protocolName ?? '프로토콜 없음'}` : `${s.slug} · 라우트 ${s.routeCount}`}</span>
            {busy === s.id && <span style={{ fontSize: 11 }}>…</span>}
          </button>
        ))}
        {servers.length === 0 && <div style={{ fontSize: 12, color: 'var(--fl-text-muted)', padding: 12 }}>읽을 수 있는 Mock 이 없습니다.</div>}
      </div>
    </div>
  )
}
