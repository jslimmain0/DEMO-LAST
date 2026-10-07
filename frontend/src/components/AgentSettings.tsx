import { useMemo, type CSSProperties } from 'react'
import type { GraphNode } from '../api/types'
import { useWorkspace, type WorkspaceOrigin } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { usesWorkflowContext } from '../lib/executionAgentSelection'
import { AppIcon } from './AppIcon'
import './execution-ui.css'
export const isBrowserRequest = (node: GraphNode) => node.type === 'http' && node.reqMode === 'client'
export const usesOwnerResources = (node: GraphNode) => isBrowserRequest(node) || usesWorkflowContext(node) || ['form', 'input', 'wait'].includes(node.type)

export function nodeAgent(node: GraphNode, owner: WorkspaceOrigin): WorkspaceOrigin {
  if (node.type === 'transform') return 'server'
  if (node.type === 'input' || node.type === 'form') return 'local'
  if (node.type === 'wait' || usesWorkflowContext(node)) return owner
  return node.executionAgent ?? owner
}
export function AgentBadge({ agent, label }: { agent: WorkspaceOrigin; label?: string }) {
  return <span className={`fl-agent-badge fl-agent-badge--${agent}`}><AppIcon name={agent === 'local' ? 'monitor' : 'server'} size={13} />{label ?? (agent === 'local' ? '내 PC' : '서버')}</span>
}
export function NodeAgentBadge({ node }: { node: GraphNode }) {
  const { current } = useWorkspace()
  if (!['http', 'tcp', 'transform', 'wait', 'form', 'input'].includes(node.type)) return null
  return <AgentBadge agent={nodeAgent(node, current.origin)} label={isBrowserRequest(node) ? '브라우저 요청' : node.type === 'wait' ? `${current.origin === 'local' ? '내 PC' : '서버'} 수신` : node.type === 'form' || node.type === 'input' ? '내 PC 화면' : undefined} />
}
export function useNodeResources(node?: GraphNode | null) {
  const scope = useWorkspace()
  const { desktop } = useAuth()
  const browser = !!node && isBrowserRequest(node)
  const ownerResources = !!node && usesOwnerResources(node)
  const agent = node && !ownerResources ? nodeAgent(node, scope.current.origin) : scope.current.origin
  const workspaceId = node?.type === 'transform' || ownerResources ? scope.current.id : agent === 'local' ? (scope.workspaces.find(w => w.origin === 'local')?.id ?? 'local') : node?.agentWorkspaceId ?? (scope.current.origin === 'server' ? scope.current.id : 'public')
  const { agentApi } = scope
  const api = useMemo(() => agentApi(agent, workspaceId), [agentApi, agent, workspaceId])
  return { agent, workspaceId, api, crossBoundary: agent !== scope.current.origin || workspaceId !== scope.current.id, key: ['agent-resources', agent, agent === 'server' ? scope.remoteKey : 'pc', workspaceId] as const, available: node?.type === 'transform' && scope.current.origin === 'local' ? false : browser || (agent === 'local' ? !!desktop : scope.connected) }
}

export function AgentSettings({ node, update, disabled }: { node: GraphNode; update: (patch: Partial<GraphNode>) => void; disabled: boolean }) {
  const scope = useWorkspace()
  const { desktop } = useAuth()
  const selectable = ['http', 'tcp'].includes(node.type)
  const agent = nodeAgent(node, scope.current.origin)
  const browser = isBrowserRequest(node)
  const legacyMock = !!node.agentMock && !browser
  const available = browser || (agent === 'local' ? !!desktop : scope.connected)
  const exceptions = [
    node.agentWorkspaceId ? `자원 공간 ${scope.workspaces.find(w => w.origin === 'server' && w.id === node.agentWorkspaceId)?.name ?? node.agentWorkspaceId}` : null,
    node.agentEnvironment != null ? `환경 ${node.agentEnvironment || '공통 환경만'}` : null,
    node.agentOutputs != null ? `위치 간 출력 ${node.agentOutputs.length ? node.agentOutputs.join(', ') : '전달 안 함'}` : null,
  ].filter(Boolean)
  if (!selectable && !['wait', 'form', 'input'].includes(node.type)) return null
  return <section className="fl-agent-settings" aria-label="노드 실행 위치" style={{ border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', padding: 12, marginBottom: 16, background: 'var(--fl-surface-2)' }}>
    {!selectable && <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}><strong style={{ fontSize: 14 }}>{node.type === 'wait' ? '콜백을 받는 위치' : '실행 위치'}</strong><NodeAgentBadge node={node} /></div>}
    {!selectable ? <p style={hint}>{node.type === 'wait' ? `현재 공간의 ${agent === 'local' ? '내 PC' : '서버'} 에이전트가 콜백을 받습니다.` : '사용자의 PC 화면에서 입력하거나 폼을 엽니다.'}</p> : <>
      <label style={label}>실행 위치<select aria-label="실행 위치" value={browser ? 'browser' : agent} disabled={disabled || scope.loading || legacyMock} onChange={e => update({ executionAgent: e.target.value as GraphNode['executionAgent'], reqMode: 'server', agentEnvironment: undefined, agentWorkspaceId: undefined, ...(browser ? { agentMock: undefined } : {}) })} style={field}>
        {browser && <option value="browser" disabled>기존 브라우저 직접 요청</option>}
        <option value="local">내 PC</option><option value="server">서버</option>
      </select></label>
      <p style={hint}>{browser ? '기존 브라우저 직접 요청입니다.' : agent === 'local' ? '실행하는 사람의 PC에서 요청합니다.' : '사내 서버에서 요청합니다.'}</p>
      <details style={hint}><summary style={{ cursor: 'pointer' }}>실행 위치 안내</summary><p style={hint}>{browser ? '내 PC 또는 서버를 선택하면 해당 위치에서 요청합니다.' : agent === 'local' ? 'localhost는 이 흐름을 실행하는 사람의 PC를 가리킵니다.' : 'localhost는 사내 서버를 가리킵니다.'}</p></details>
      {legacyMock && <p role="status" style={hint}>기존 Mock 연결이 있습니다. 주소 설정에서 ‘주소 직접 입력’으로 전환한 뒤 실행 위치를 바꾸세요.</p>}
      {!available && <p role="status" style={{ ...hint, color: 'var(--fl-waiting)' }}>{agent === 'local' ? 'PC 실행에는 FlowLink Windows 앱이 필요합니다.' : 'Windows 앱에서 서버에 로그인하세요.'}</p>}
      {exceptions.length > 0 && <p style={{ ...hint, overflowWrap: 'anywhere' }}>기존 예외 설정: {exceptions.join(' · ')}{browser && (node.agentWorkspaceId || node.agentEnvironment != null) ? ' · 자원 공간·환경 예외는 브라우저 요청에 적용되지 않습니다.' : ''}</p>}
      {!browser && node.agentEnvironment != null && <button type="button" disabled={disabled} onClick={() => update({ agentEnvironment: undefined })} style={{ ...field, width: 'auto' }}>실행 계획의 환경 사용</button>}
    </>}
  </section>
}
const label: CSSProperties = { display: 'block', fontSize: 14, fontWeight: 600 }
const field: CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 5, minHeight: 36, padding: '8px 10px', background: 'var(--fl-surface)', color: 'var(--fl-text)', border: '1px solid var(--fl-border)', borderRadius: 6, font: 'inherit', fontSize: 13 }
const hint: CSSProperties = { fontSize: 12, lineHeight: 1.55, color: 'var(--fl-text-muted)', margin: '7px 0 0' }
