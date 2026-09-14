import type { CSSProperties } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { flowsApi, mocksApi } from '../api/client'
import type { GraphNode, MockFleetServer } from '../api/types'
import { apiErrorMessage } from '../lib/apiError'
import { alignPatch, mirrorDiff, mockTcpToNode, nodeToMockTcp } from '../lib/tcpMirror'
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
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 다른 노드를 고르면 열린 드롭다운은 닫는다(이 패널은 노드마다 다시 그려지지 않고 props 만 바뀐다)
  useEffect(() => { setOpen(false) }, [node.id])
  // Esc — 열려 있는 동안 **캡처 단계에서 삼킨다**: 부모 속성 모달(Esc 스택)도, 캔버스의 '선택 해제'(Editor 전역 핸들러)도
  // 같이 반응하면 고르던 중에 노드 선택까지 풀린다.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  /** 전체 가져오기 — 연결·레이아웃·응답 필드를 Mock 것으로 교체한다(요청 값·토큰은 비워진다). */
  const pick = async (s: MockFleetServer) => {
    setBusy(true)
    try {
      const d = await mocksApi.get(s.id)
      if (!d.spec.tcp) { toast('이 Mock 에는 TCP 정의가 없습니다', 'error'); return }
      onApply(mockTcpToNode(d.spec.tcp, d.spec.tcp.rules?.[0] ?? null, window.location.hostname || 'localhost'))
      toast(`'${d.name}' 의 연결·레이아웃·응답 필드를 가져왔습니다 — 요청 값은 비워졌으니 다시 입력하세요`, 'ok')
      setOpen(false)
    } catch (e) { toast(apiErrorMessage(e, '가져오기 실패'), 'error') } finally { setBusy(false) }
  }
  /** 항목별 맞추기 — 다른 항목(연결·응답 길이)만 패치하고 값·토큰은 그대로 둔다. */
  const align = () => {
    const tcp = detail.data?.spec.tcp
    if (!tcp) return
    const { patch, skipped } = alignPatch(node, tcp, tcp.rules?.[0] ?? null)
    if (Object.keys(patch).length) onApply(patch)
    if (skipped.length) toast(`${skipped.join(' · ')} 은(는) 표 구조가 달라 맞추지 못했습니다 — [Mock 에서 고르기] 로 통째로 가져오세요(요청 값은 비워집니다)`, 'info')
    else if (Object.keys(patch).length) toast('Mock 값에 맞췄습니다 — 요청 값·토큰은 그대로입니다', 'ok')
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
      try {
        await mocksApi.updateSpec(created.id, { ...created.spec, tcp: nodeToMockTcp(node, { port }) }, { note: '워크플로 TCP 노드에서 생성' })
      } catch (e) {
        // spec 저장 실패(포트 충돌 등)면 기본 정의로 서빙되는 빈 mock 이 남지 않게 정리(slug·포트는 전역 자원)
        await mocksApi.remove(created.id).catch(() => {})
        throw e
      }
      // fleet/목록을 즉시 갱신 — 안 하면 최대 5초(폴링)동안 칩이 '같은 포트의 내장 Mock 없음' 인 채라 또 만들 수 있다
      void qc.invalidateQueries({ queryKey: ['mock-fleet'] })
      void qc.invalidateQueries({ queryKey: ['mock-servers'] })
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
            {canEdit && linked && <button style={btn} disabled={busy} onClick={align} title="다른 항목(포트·인코딩·프리픽스·응답 필드 길이)만 Mock 값으로 맞춥니다 — 요청 값·토큰은 그대로">Mock 값으로 맞추기</button>}
          </details>)}
      {canEdit && (
        <span style={{ position: 'relative' }}>
          <button style={btn} disabled={busy} onClick={() => setOpen((v) => !v)} aria-expanded={open} title="고른 Mock 의 연결·레이아웃·응답 필드를 통째로 가져옵니다(요청 값은 비워집니다)">Mock 에서 고르기 ▾</button>
          {open && <div style={{ position: 'fixed', inset: 0, zIndex: 49 }} onClick={() => setOpen(false)} />}
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
