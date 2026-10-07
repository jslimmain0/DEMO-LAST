import type { GraphNode } from '../api/types'

export type ExecutionAgent = NonNullable<GraphNode['executionAgent']>

export function canChangeExecutionAgent(node: GraphNode): boolean {
  const browser = node.type === 'http' && node.reqMode === 'client'
  return ['http', 'tcp', 'set', 'if', 'assert'].includes(node.type) && (!node.agentMock || browser)
}

/** 위치를 실제로 바꿀 때만 이전 목적지의 공간·환경 예외를 해제한다. */
export function executionAgentPatch(node: GraphNode, target: ExecutionAgent, owner: ExecutionAgent): Partial<GraphNode> | null {
  if (!canChangeExecutionAgent(node)) return null
  const browser = node.type === 'http' && node.reqMode === 'client'
  if (!browser && node.executionAgent === target) return null
  if (!browser && (node.executionAgent ?? owner) === target) return { executionAgent: target }
  return { executionAgent: target, reqMode: 'server', agentEnvironment: undefined, agentWorkspaceId: undefined,
    ...(browser ? { agentMock: undefined } : {}) }
}
