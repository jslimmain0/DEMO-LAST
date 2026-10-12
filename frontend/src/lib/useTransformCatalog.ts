import { useQuery } from '@tanstack/react-query'
import type { GraphNode } from '../api/types'
import { useWorkspace } from '../app/WorkspaceContext'
import { useNodeResources } from '../components/AgentSettings'

/** 플러그인은 서버 공통 목록만 사용한다. 호출 노드의 실행 위치와 무관하다. */
export function useTransformCatalog(node?: GraphNode | null) {
  const scope = useWorkspace()
  const resources = useNodeResources({ ...node, type: 'transform' } as GraphNode)
  const allowed = true
  const query = useQuery({ queryKey: ['transforms', ...resources.key], queryFn: resources.api.transformsApi.list, enabled: resources.available, staleTime: 60_000 })
  const label = '서버 공통'
  const location = `/plugins?space=${encodeURIComponent(`${scope.current.origin}:${scope.current.id}`)}`
  return { resources, query, label, location, allowed, newLocation: `${location}&new=transform` }
}
