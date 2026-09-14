import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { flowsApi, mocksApi } from '../api/client'
import type { GraphNode, MockFleetServer } from '../api/types'
import { apiErrorMessage } from '../lib/apiError'
import { mirrorDiff, mockTcpToNode, nodeToMockTcp } from '../lib/tcpMirror'
import { toast } from './toast'

// 노드 대상이 "이 서버"를 가리킬 때만 내장 Mock 과 같은 포트로 볼 수 있다(원격 호스트는 남의 시스템).
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', window.location.hostname])

/**
 * TCP 노드 ⇄ 내장 TCP Mock 연동 칩 — 같은 포트의 Mock 을 fleet(모든 워크스페이스)에서 찾아 정합성(포트·인코딩·프리픽스·필드 길이)을 보여주고,
 * [Mock 에서 고르기] 로 연결·레이아웃·응답 필드를 통째로 가져오거나 [대상 Mock 만들기] 로 이 노드의 거울 Mock 을 만든다.
 */
export function TcpMockLink({ node, flowId, canEdit, onApply }: { node: GraphNode; flowId: string; canEdit: boolean; onApply: (patch: Partial<GraphNode>) => void }) {
  const fleet = useQuery({ queryKey: ['mock-fleet'], queryFn: mocksApi.fleet, refetchInterval: 5000 })
  const flow = useQuery({ queryKey: ['flow', flowId], queryFn: () => flowsApi.get(flowId), enabled: !!flowId, staleTime: 60_000 })
  const tcpServers = useMemo(() => (fleet.data?.servers ?? []).filter((s) => s.kind === 'TCP'), [fleet.data])
  const linked = useMemo(() => (LOCAL_HOSTS.has(node.tcpHost ?? '') ? tcpServers.find((s) => s.tcpPort === node.tcpPort) : undefined), [tcpServers, node.tcpHost, node.tcpPort])
  const detail = useQuery({ queryKey: ['mock-server', linked?.id], queryFn: () => mocksApi.get(linked!.id), enabled: !!linked?.readable, staleTime: 5000 })
  const diff = useMemo(() => (detail.data?.spec.tcp ? mirrorDiff(node, detail.data.spec.tcp, detail.data.spec.tcp.rules?.[0] ?? null) : null), [detail.data, node])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const pick = async (s: MockFleetServer) => {
    setBusy(true)
    try {
      const d = await mocksApi.get(s.id)
      if (!d.spec.tcp) { toast('이 Mock 에는 TCP 정의가 없습니다', 'error'); return }
      onApply(mockTcpToNode(d.spec.tcp, d.spec.tcp.rules?.[0] ?? null, window.location.hostname || 'localhost'))
      toast(`'${d.name}' 의 연결·레이아웃·응답 필드를 가져왔습니다`, 'ok')
      setOpen(false)
    } catch (e) { toast(apiErrorMessage(e, '가져오기 실패'), 'error') } finally { setBusy(false) }
  }
  const createMock = async () => {
    setBusy(true)
    try {
      const base = `tcp-${(node.name || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'node'}`
      let slug = base
      for (let i = 2; !(await mocksApi.slugCheck(slug)).available && i < 50; i++) slug = `${base}-${i}`
      const created = await mocksApi.create({ name: `${node.name || 'TCP'} (Mock)`, slug, type: 'TCP', workspaceId: flow.data?.workspaceId ?? 'public' })
      // 노드 대상 = 실제로 저장되는 Mock 포트(nodeToMockTcp 의 폴백과 같은 값이라 양쪽이 항상 일치)
      const port = created.spec.tcp?.port ?? node.tcpPort ?? 9091
      await mocksApi.updateSpec(created.id, { ...created.spec, tcp: nodeToMockTcp(node, { port }) }, { note: '워크플로 TCP 노드에서 생성' })
      onApply({ tcpHost: window.location.hostname || 'localhost', tcpPort: port })
      toast(`대상 Mock '${created.name}' 을 만들고 노드 대상을 :${port} 로 맞췄습니다`, 'ok')
    } catch (e) { toast(apiErrorMessage(e, 'Mock 만들기 실패'), 'error') } finally { setBusy(false) }
  }

  return (
    <div style={wrap}>
      {linked ? (
        <span style={chip(linked.listening ? 'ok' : 'warn')} title={linked.readable ? undefined : '접근 권한이 없는 워크스페이스의 Mock'}>
          🔌 Mock '{linked.name}' :{linked.tcpPort} {linked.listening ? '· 리스닝' : linked.listenError ? '· 바인딩 실패' : '· 꺼짐'}
        </span>
      ) : <span style={chip('muted')}>🔌 같은 포트의 내장 Mock 없음</span>}
      {diff && (diff.length === 0
        ? <span style={chip('ok')}>✓ 레이아웃 일치</span>
        : <details style={{ fontSize: 11.5 }}><summary style={{ cursor: 'pointer', color: 'var(--fl-put, #f5a623)' }}>⚠ 불일치 {diff.length}</summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>{diff.map((x) => <li key={x.field}>{x.field}: 노드 {x.node} / Mock {x.mock}</li>)}</ul>
            {canEdit && linked && <button style={btn} disabled={busy} onClick={() => void pick(linked)}>Mock 값으로 맞추기</button>}
          </details>)}
      {canEdit && (
        <span style={{ position: 'relative' }}>
          <button style={btn} disabled={busy} onClick={() => setOpen((v) => !v)} aria-expanded={open}>Mock 에서 고르기 ▾</button>
          {open && (
            <div style={menu} role="menu">
              {tcpServers.length === 0 && <div style={{ padding: 8, fontSize: 12, color: 'var(--fl-text-muted)' }}>TCP Mock 이 없습니다</div>}
              {tcpServers.map((s) => (
                <button key={s.id} role="menuitem" style={item} disabled={!s.readable || busy} title={s.readable ? undefined : '읽기 권한 없음'} onClick={() => void pick(s)}>
                  {s.name} <span style={{ color: 'var(--fl-text-muted)' }}>:{s.tcpPort} {s.listening ? '● 리스닝' : '○'}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      )}
      {canEdit && !linked && <button style={btn} disabled={busy} onClick={() => void createMock()} title="이 노드의 요청 레이아웃/응답 필드를 거울로 가진 TCP Mock 을 만들고 대상을 그 포트로 맞춥니다">대상 Mock 만들기</button>}
    </div>
  )
}

const wrap: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 8px' }
function chip(kind: 'ok' | 'warn' | 'muted'): CSSProperties {
  const color = kind === 'ok' ? 'var(--fl-ok)' : kind === 'warn' ? 'var(--fl-put, #f5a623)' : 'var(--fl-text-muted)'
  return { fontSize: 11.5, padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}`, color }
}
const btn: CSSProperties = { fontSize: 11.5, padding: '3px 8px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', cursor: 'pointer' }
const menu: CSSProperties = { position: 'absolute', top: '110%', left: 0, zIndex: 50, minWidth: 240, background: 'var(--fl-surface)', border: '1px solid var(--fl-border)', borderRadius: 8, boxShadow: 'var(--fl-shadow)', padding: 4, display: 'grid' }
const item: CSSProperties = { textAlign: 'left', padding: '6px 8px', border: 'none', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', fontSize: 12.5, borderRadius: 6 }
