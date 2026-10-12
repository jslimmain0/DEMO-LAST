import type { MockFleet, MockFleetPort } from '../api/types'
import type { WorkspaceOrigin } from '../app/WorkspaceContext'

export type MockCatalogPort = MockFleetPort & { origin?: WorkspaceOrigin; contextPath?: string }
export type MockCatalogFleet = Omit<MockFleet, 'ports'> & { ports: MockCatalogPort[] }

// 서로 다른 호스트에 같은 ID가 있어도 선택·즐겨찾기·변경 대상을 혼동하지 않는다.
export function locatedFleet(fleet: MockFleet, origin: WorkspaceOrigin): MockCatalogFleet {
  const key = (id: string) => `${origin}:${id}`
  return { ...fleet,
    workspaces: fleet.workspaces.map(w => ({ ...w, id: key(w.id), name: origin === 'local' ? '내 PC' : w.name })),
    servers: fleet.servers.map(s => ({ ...s, id: key(s.id), workspaceId: key(s.workspaceId) })),
    ports: fleet.ports.map(p => ({ ...p, origin, contextPath: fleet.contextPath, mockId: p.mockId ? key(p.mockId) : p.mockId, workspaceId: p.workspaceId ? key(p.workspaceId) : p.workspaceId })),
  }
}
export function mockLocation(key: string): { origin: WorkspaceOrigin; id: string } {
  const colon = key.indexOf(':')
  const origin = key.slice(0, colon)
  if (colon < 1 || !['local', 'server'].includes(origin)) throw new Error('Mock 위치를 확인할 수 없습니다.')
  return { origin: origin as WorkspaceOrigin, id: key.slice(colon + 1) }
}
