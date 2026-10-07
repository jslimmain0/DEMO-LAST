import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { isAxiosError } from 'axios'
import { useWorkspace } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { useEditorStore } from '../store/editorStore'
import { asGraphNode } from '../canvas/graphAdapter'
import { typeLabel } from '../canvas/nodeMeta'
import { topoOrder } from '../lib/runProgress'
import { computeReachInfo } from '../lib/reachable'
import { useEnvStore, useEnvironment } from '../lib/environments'
import type { RunRequest } from '../api/types'
import { usesWorkflowContext } from '../lib/executionAgentSelection'
import { AgentBadge, nodeAgent, isBrowserRequest, usesOwnerResources } from './AgentSettings'
import { destinationKey, resolveAgentEnvironment } from '../lib/agentEnvironments'
import { useAgentEnvironmentBindings } from '../lib/useAgentEnvironmentBindings'
import { Modal } from './Modal'
import { ActionButton } from './ActionButton'

export function ExecutionPlanDialog({ onClose, onRun }: { onClose: () => void; onRun: (dependencies: RunRequest['agentDependencies'], environments: Record<string, string>) => void }) {
  const scope = useWorkspace()
  const { desktop } = useAuth()
  const environment = useEnvStore()
  const environmentStore = useEnvironment()
  const bindings = useAgentEnvironmentBindings()
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preparation = useQuery({ queryKey: ['execution-environment-ready', scope.scopeKey], queryFn: async () => { await environmentStore.prepareForRun(); return true }, staleTime: 0, gcTime: 0, retry: false })
  const nodes = useEditorStore(s => s.nodes)
  const edges = useEditorStore(s => s.edges)
  const plan = useMemo(() => {
    const reach = computeReachInfo(nodes, edges)
    return topoOrder(nodes, edges).map(id => asGraphNode(nodes.find(n => n.id === id)!.data))
      .filter(n => !['start', 'end', 'note', 'group'].includes(n.type) && (!reach.hasStart || reach.reachable.has(n.id)))
  }, [nodes, edges])
  const planIdentity = `${scope.scopeKey}:${scope.remoteKey}:${environment.active}:${JSON.stringify(plan)}:${JSON.stringify(bindings.bindings)}`
  const latestPlan = useRef(planIdentity)
  latestPlan.current = planIdentity
  const isAvailable = (n: typeof plan[number]) => {
    if (n.type === 'transform' && scope.current.origin === 'local') return false
    const agent = nodeAgent(n, scope.current.origin)
    return isBrowserRequest(n) || (agent === 'local' ? !!desktop || ['form', 'input'].includes(n.type) : scope.connected && !scope.remoteError)
  }
  const ownerResources = usesOwnerResources
  const resourceSpace = (n: typeof plan[number]) => n.type === 'transform' || ownerResources(n) ? scope.current.id : nodeAgent(n, scope.current.origin) === 'local' ? scope.workspaces.find(w => w.origin === 'local')?.id ?? 'local' : n.agentWorkspaceId ?? (scope.current.origin === 'server' ? scope.current.id : 'public')
  const environmentSelection = (n: typeof plan[number]) => n.type === 'transform' || ownerResources(n) ? { name: environment.active ?? '', source: n.type === 'transform' ? '중앙 플러그인 · 워크플로 환경' : usesWorkflowContext(n) ? '워크플로 환경에서 계산' : '워크플로 공간에서 값 조립' } : resolveAgentEnvironment(n, nodeAgent(n, scope.current.origin), resourceSpace(n), scope.current, environment.active, bindings.bindings)
  const environmentName = (n: typeof plan[number]) => environmentSelection(n).name
  const destinations = [...new Map(plan.filter(n => !isBrowserRequest(n) && ['http', 'tcp'].includes(n.type)).map(n => [destinationKey(nodeAgent(n, scope.current.origin), resourceSpace(n)), { agent: nodeAgent(n, scope.current.origin), workspaceId: resourceSpace(n) }])).entries()]
  const inspections = useQueries({ queries: plan.map(n => {
    const agent = ownerResources(n) ? scope.current.origin : nodeAgent(n, scope.current.origin)
    const workspaceId = ownerResources(n) ? scope.current.id : resourceSpace(n)
    const envName = environmentName(n)
    const enabled = bindings.ready && envName !== undefined && preparation.isSuccess && !preparation.isFetching && isAvailable(n) && ['http', 'tcp', 'set', 'if', 'assert', 'transform', 'form', 'input'].includes(n.type)
    return { queryKey: ['agent-inspection', agent, agent === 'server' ? scope.remoteKey : 'pc', workspaceId, envName, n], queryFn: () => scope.agentApi(agent, workspaceId).runsApi.inspectAgent(ownerResources(n) ? n : { ...n, executionAgent: agent }, envName), enabled, retry: false, staleTime: 0 }
  }) })
  const checking = preparation.isPending || preparation.isFetching || inspections.some(r => r.isFetching)
  const invalid = preparation.isError || inspections.some(r => r.isError || r.data?.ready === false)
  const missing = plan.some(n => !isBrowserRequest(n) && ['http', 'tcp', 'set', 'if', 'assert', 'transform'].includes(n.type) && environmentName(n) === undefined)
  const blocked = !bindings.ready || missing || saving || plan.some(n => !isAvailable(n)) || checking || invalid
  return <Modal onClose={onClose} ariaLabel="실행 계획" width={1100} card={{ padding: 22, overflowY: 'auto' }}>
    <header style={{ display: 'flex', gap: 12, alignItems: 'center' }}><strong style={{ fontSize: 18 }}>실행 계획</strong><button aria-label="실행 계획 닫기" onClick={onClose} style={{ ...button, marginLeft: 'auto' }}>닫기</button></header>
    <p style={{ fontSize: 12.5, lineHeight: 1.65, color: 'var(--fl-text-muted)' }}>저장 공간: <b style={{ color: 'var(--fl-text)' }}>{scope.current.name} · {scope.current.origin === 'local' ? '개인 PC H2' : '서버 DB'}</b><br />HTTP·TCP는 선택한 위치에서 호출합니다. 변수·조건·검증은 워크플로의 환경과 앞 노드의 결과로 계산합니다.</p>
    {destinations.length > 0 && <section aria-label="이 PC의 연결 설정" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '12px 0' }}><b style={{ width: '100%', fontSize: 12 }}>이 PC의 연결 설정 · {environment.active || '공통 환경'} 단계 {bindings.persistent ? '· PC에 저장' : '· 현재 세션에서 사용'}</b>
      {destinations.map(([key, target]) => <DestinationEnvironment key={key} destination={key} target={target} bindings={bindings} />)}
      <button style={button} disabled={!bindings.ready || !bindings.dirty || saving} onClick={async () => { setSaving(true); setSaveError(''); try { await bindings.save() } catch (error) { setSaveError(isAxiosError(error) ? error.response?.data?.message ?? error.message : error instanceof Error ? error.message : '연결 설정 저장 실패') } finally { setSaving(false) } }}>{saving ? '저장 중…' : bindings.dirty ? '연결 설정 저장' : '연결 설정 저장됨'}</button>
    </section>}
      {bindings.error && <p role="alert">연결 설정을 불러오지 못했습니다. {bindings.error instanceof Error ? bindings.error.message : ''} <button style={button} onClick={() => void bindings.reload()}>다시 불러오기</button></p>}
      {saveError && <p role="alert" style={{ color: 'var(--fl-fail)' }}>{saveError} <button style={button} disabled={saving} onClick={async () => { if (bindings.dirty && !window.confirm('내 연결 선택을 취소하고 마지막으로 저장된 설정을 불러올까요?')) return; const result = await bindings.reload(true); if (result.isSuccess) setSaveError('') }}>저장된 설정 다시 불러오기</button></p>}
    <div className="fl-execution-plan-table" style={{ maxHeight: '55vh', overflow: 'auto' }}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, textAlign: 'left' }}>
      <thead><tr>{['순서·노드', '실행·수신 위치', '자원 공간', '환경·대상', '위치 간 전달', '준비 상태'].map(t => <th key={t} style={{ ...cell, color: 'var(--fl-text-muted)', fontWeight: 600 }}>{t}</th>)}</tr></thead>
      <tbody>{plan.map((n, i) => {
        const agent = isBrowserRequest(n) ? scope.current.origin : nodeAgent(n, scope.current.origin)
        const spaceId = resourceSpace(n)
        const resourceAgent = ownerResources(n) ? scope.current.origin : agent
        const space = scope.workspaces.find(w => w.origin === resourceAgent && w.id === spaceId)
        const personalPlugin = n.type === 'transform' && scope.current.origin === 'local'
        const available = isAvailable(n)
        const inspection = inspections[i]
        const issue = inspection.isError ? (isAxiosError(inspection.error) ? inspection.error.response?.data?.message ?? '자원 확인 실패' : inspection.error.message) : inspection.data?.issues.join(' · ')
        const presentation = n.type === 'form' ? '브라우저 팝업 · 실행 시 주소 조립' : n.type === 'input' ? '사용자 입력 · 대상 주소 없음' : n.type === 'wait' ? '콜백 수신 대기' : n.type === 'switch' ? `저장된 선택 경로 · ${n.switchActive || '1'}` : undefined
        return <tr key={n.id}><td style={cell}><b>{i + 1}. {n.name || typeLabel(n.type)}</b><small style={{ display: 'block', marginTop: 4, color: 'var(--fl-text-muted)' }}>{typeLabel(n.type)}</small></td>
          <td style={cell}>{usesWorkflowContext(n) ? <span style={{ color: 'var(--fl-text-muted)' }}>—</span> : <AgentBadge agent={agent} label={isBrowserRequest(n) ? '브라우저 요청' : n.type === 'wait' ? `${agent === 'local' ? '내 PC' : '서버'} 수신` : undefined} />}</td>
          <td style={{ ...cell, minWidth: 140, maxWidth: 230, overflowWrap: 'anywhere' }}><b>{personalPlugin ? '개인 공간에서 사용 불가' : space?.name ?? (spaceId === 'public' ? '공용' : '접근 확인 필요')}</b><small style={{ display: 'block', marginTop: 4, color: 'var(--fl-text-muted)' }} title={spaceId}>{personalPlugin ? '공용·팀 워크스페이스에서 구성하세요' : `${resourceAgent === 'local' ? '내 PC' : '서버'} · ${spaceId.slice(0, 8)}`}</small></td>
          <td style={{ ...cell, maxWidth: 250, overflowWrap: 'anywhere' }}>{n.type === 'input' ? '사용자 입력 · 대상 주소 없음' : environmentName(n) === undefined ? '환경 미설정' : environmentName(n) || '공통 환경'}{n.type !== 'input' && <small style={{ display: 'block', marginTop: 4 }}>{environmentSelection(n).source}</small>}<small style={{ display: 'block', marginTop: 4 }}>{inspection.data?.targetDiagnostics?.resolvedTarget ?? (inspection.data?.targetDiagnostics?.source === 'upstream-binding' ? '상류 출력에 따라 실행 시 결정' : presentation ?? (['http', 'tcp'].includes(n.type) ? '대상 주소 구성 확인 필요' : '—'))}</small>{inspection.data?.targetDiagnostics?.warnings.map(warning => <small key={warning} style={{ display: 'block', marginTop: 4 }}>{warning}</small>)}</td>
          <td style={{ ...cell, maxWidth: 190, overflowWrap: 'anywhere' }}>{usesWorkflowContext(n) ? '흐름 내 출력' : n.agentOutputs == null ? '필요한 출력 키 자동 선택' : n.agentOutputs.length ? n.agentOutputs.join(', ') : '전달 없음'}</td>
          <td style={{ ...cell, maxWidth: 230, overflowWrap: 'anywhere', color: available && !issue ? 'var(--fl-ok)' : 'var(--fl-waiting)' }}>{!available ? n.type === 'transform' && scope.current.origin === 'local' ? '공용·팀 공간 전용' : agent === 'local' ? 'PC 앱 필요' : '서버 연결 필요' : environmentName(n) === undefined ? '환경 선택 필요' : inspection.isFetching ? '구성 확인 중…' : issue || (inspection.data?.ready ? isBrowserRequest(n) ? '브라우저 요청 구성 확인' : '구성 확인 완료' : presentation ?? '연결 준비')}</td></tr>
      })}</tbody>
    </table></div>
    <p style={{ fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.65 }}>구성 확인은 실제 네트워크 접속 확인이 아닙니다. 시크릿은 실행 위치의 공간에서 읽습니다. 브라우저 요청은 워크플로 공간의 환경을 사용합니다.</p>
    {preparation.isError && <p role="alert" style={{ color: 'var(--fl-fail)', fontSize: 12 }}>환경을 준비하지 못해 실행하지 않습니다. {preparation.error.message}</p>}
    {invalid && <button style={button} onClick={async () => { const ready = await preparation.refetch(); if (ready.isSuccess) await Promise.all(inspections.filter((r, i) => isAvailable(plan[i]) && (r.isError || r.data?.ready === false)).map(r => r.refetch())) }}>환경·자원 다시 확인</button>}
    {blocked && <p role="alert" style={{ fontSize: 12, color: 'var(--fl-waiting)' }}>{checking ? '실행에 필요한 자원을 확인하고 있습니다.' : '위에 표시된 연결·자원 문제를 수정한 뒤 실행하세요.'}</p>}
    <footer className="fl-execution-plan-actions"><ActionButton disabled={saving} onClick={onClose}>계속 편집</ActionButton><ActionButton variant="primary" disabled={blocked} onClick={async () => {
      const dependencies: NonNullable<RunRequest['agentDependencies']> = {}
      plan.forEach((n, i) => { const hashes = inspections[i].data?.dependencyHashes; if (hashes && Object.keys(hashes).length) dependencies[n.id] = hashes })
      const inspectedPlan = latestPlan.current
      setSaving(true); setSaveError('')
      try { const environments = await bindings.save(); if (!mounted.current) return; if (latestPlan.current !== inspectedPlan) throw new Error('실행 준비 중 공간·환경·노드 설정이 바뀌었습니다. 현재 계획을 다시 확인하세요.'); onClose(); onRun(dependencies, environments) }
      catch (error) { setSaveError(isAxiosError(error) ? error.response?.data?.message ?? error.message : error instanceof Error ? error.message : '연결 설정을 저장하지 못했습니다. 다시 실행 버튼을 눌러 재시도하세요.') }
      finally { setSaving(false) }
    }}>이 계획으로 실행</ActionButton></footer>
  </Modal>
}
function DestinationEnvironment({ destination, target, bindings }: { destination: string; target: { agent: 'local' | 'server'; workspaceId: string }; bindings: ReturnType<typeof useAgentEnvironmentBindings> }) {
  const scope = useWorkspace()
  const environment = useEnvStore()
  const [search, setSearch] = useState('')
  const { agentApi } = scope
  const api = useMemo(() => agentApi(target.agent, target.workspaceId), [agentApi, target.agent, target.workspaceId])
  const query = useQuery({ queryKey: ['destination-environments', target.agent, target.agent === 'server' ? scope.remoteKey : 'pc', target.workspaceId], queryFn: api.environmentsApi.list, enabled: target.agent === 'local' || scope.connected, retry: false })
  const own = target.agent === scope.current.origin && target.workspaceId === scope.current.id
  const selected = Object.hasOwn(bindings.bindings, destination) ? bindings.bindings[destination] : own ? environment.active ?? '' : '__unset__'
  const name = scope.workspaces.find(w => w.origin === target.agent && w.id === target.workspaceId)?.name ?? (target.workspaceId === 'public' ? '공용' : target.workspaceId.slice(0, 8))
  return <label style={{ fontSize: 12, flex: '1 1 240px' }}>{target.agent === 'local' ? '내 PC' : '서버'} · {name}
    {(query.data?.length ?? 0) > 10 && <input type="search" aria-label={`${name} 환경 검색`} value={search} onChange={e => setSearch(e.target.value)} placeholder="환경 이름 검색" style={{ ...button, width: '100%', boxSizing: 'border-box', marginTop: 6 }} />}
    <select aria-label={`${name} 연결 환경`} disabled={!bindings.ready || !query.isSuccess} value={selected} onChange={e => bindings.update(destination, e.target.value === '__unset__' ? undefined : e.target.value)} style={{ ...button, display: 'block', width: '100%', marginTop: 6 }}>
      {!own && <option value="__unset__">환경을 명시적으로 선택하세요</option>}<option value="">공통 환경만</option>
      {(query.data ?? []).filter(env => env.name === selected || env.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(env => <option key={env.name} value={env.name}>{env.name}</option>)}
      {selected && selected !== '__unset__' && !query.data?.some(env => env.name === selected) && <option value={selected}>{selected} · 존재 확인 필요</option>}
    </select>{query.isError && <span role="alert">환경 목록을 읽지 못했습니다. <button style={button} onClick={() => void query.refetch()}>다시 확인</button></span>}
  </label>
}
const cell: CSSProperties = { padding: '12px 8px', borderBottom: '1px solid var(--fl-border)', verticalAlign: 'top' }
const button: CSSProperties = { padding: '8px 12px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-text)', font: 'inherit', fontSize: 13, cursor: 'pointer' }
