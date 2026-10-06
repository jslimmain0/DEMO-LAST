import { useQuery } from '@tanstack/react-query'
import type { GraphNode } from '../api/types'
import { useWorkspace } from '../app/WorkspaceContext'
import { useNodeResources } from '../components/AgentSettings'

/** 플러그인은 공용·팀 공간의 중앙 목록만 사용한다. 호출 노드의 실행 위치와 무관하다. */
export function useTransformCatalog(node?: GraphNode | null) {
  const scope = useWorkspace()
  const resources = useNodeResources({ ...node, type: 'transform' } as GraphNode)
  const allowed = scope.current.origin === 'server'
  const query = useQuery({ queryKey: ['transforms', ...resources.key], queryFn: resources.api.transformsApi.list, enabled: resources.available, staleTime: 60_000 })
  const workspace = scope.workspaces.find(w => w.origin === resources.agent && w.id === resources.workspaceId)
  const name = (workspace?.kind === 'PERSONAL' ? '개인 공간' : workspace?.name)
    ?? (resources.workspaceId === 'public' ? '공용' : resources.agent === 'local' ? '개인 공간' : resources.workspaceId)
  const label = name
  const location = `/plugins?space=${encodeURIComponent(`${resources.agent}:${resources.workspaceId}`)}`
  return { resources, query, label, location, allowed, newLocation: `${location}&new=transform` }
}
