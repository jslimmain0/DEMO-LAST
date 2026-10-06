import type { GraphNode } from '../api/types'
import type { WorkspaceOrigin } from '../app/WorkspaceContext'

export type AgentEnvironmentMap = Record<string, string>
export function destinationKey(agent: WorkspaceOrigin, workspaceId: string) {
  return agent === 'local' ? 'local' : `server:${workspaceId || 'public'}`
}

/** 같은 이름으로 다른 공간의 환경을 추정하지 않는다. 빈 문자열은 명시적인 공통 환경. */
export function resolveAgentEnvironment(node: GraphNode, agent: WorkspaceOrigin, workspaceId: string, owner: { origin: WorkspaceOrigin; id: string }, stage: string | null, mapping: AgentEnvironmentMap) {
  if (node.type === 'transform') return { name: stage ?? '', source: '중앙 플러그인 · 워크플로 환경' }
  if (node.agentEnvironment != null) return { name: node.agentEnvironment, source: '노드에서 지정' }
  const key = destinationKey(agent, workspaceId)
  if (Object.hasOwn(mapping, key)) return { name: mapping[key], source: '이 PC의 연결 설정' }
  if (agent === owner.origin && workspaceId === owner.id) return { name: stage ?? '', source: '워크플로 선택 환경' }
  return { name: undefined, source: '미설정' }
}

export function targetReferenceLabel(node: GraphNode) {
  if (node.agentMock) return `Mock · ${node.agentMock}`
  if (node.type === 'tcp' && node.tcpPortEnvKey) return `환경 포트 · ${node.tcpPortEnvKey}`
  return '워크플로 주소'
}
