import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWorkspace } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { desktopApi, type EnvironmentBindings } from '../auth/desktop'
import { useEnvStore } from './environments'
const drafts = new Map<string, EnvironmentBindings & { dirty?: boolean }>()
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (![...drafts.values()].some(draft => draft.dirty)) return
  event.preventDefault(); event.returnValue = ''
})

/** 공간·단계마다 이 PC에서 선택한 연결. 공유 그래프에는 기록하지 않는다. */
export function useAgentEnvironmentBindings() {
  const workspace = useWorkspace()
  const auth = useAuth()
  const environment = useEnvStore()
  const queryClient = useQueryClient()
  const connection = useQuery({ queryKey: ['desktop', 'connection'], queryFn: desktopApi.connection, enabled: !!auth.desktop, refetchInterval: 3000, retry: false })
  const identity = auth.desktop ? connection.data : undefined
  const identityReady = auth.ready && (auth.desktop ? connection.isSuccess : !!auth.me?.username)
  const owner = { origin: workspace.current.origin, workspaceId: workspace.current.id, environment: environment.active }
  const key = ['agent-environment-bindings', owner.origin, owner.workspaceId, owner.environment, auth.desktop ? identity?.serverUrl ?? '' : window.location.origin, auth.desktop ? identity?.login ?? '' : auth.me?.username ?? ''] as const
  const draftKey = JSON.stringify(key)
  const loaded = useQuery({ queryKey: key, queryFn: async () => {
    const saved = auth.desktop && identity ? await desktopApi.environmentBindings(owner, identity) : { bindings: {}, revision: '' }
    return drafts.get(draftKey) ?? saved
  }, enabled: identityReady, retry: false, staleTime: Infinity, gcTime: Infinity })
  const ready = identityReady && loaded.isSuccess
  const dirty = !!(loaded.data as EnvironmentBindings & { dirty?: boolean } | undefined)?.dirty
  const update = (destination: string, name: string | undefined) => {
    if (!ready) return
    const bindings = { ...loaded.data.bindings }
    if (name === undefined) delete bindings[destination]
    else bindings[destination] = name
    const draft = { ...loaded.data!, bindings, dirty: true }
    drafts.set(draftKey, draft)
    queryClient.setQueryData(key, draft)
  }
  const save = async () => {
    if (!ready) throw new Error('이 PC의 연결 설정을 먼저 불러오세요.')
    const current = queryClient.getQueryData<EnvironmentBindings & { dirty?: boolean }>(key)!
    if (!current.dirty) return current.bindings
    const saved = auth.desktop && identity ? await desktopApi.saveEnvironmentBindings(owner, current, identity) : current
    // A 저장 중 B 편집한 값을 A 응답으로 덮어쓰지 않는다.
    const latest = queryClient.getQueryData<EnvironmentBindings & { dirty?: boolean }>(key)!
    queryClient.setQueryData(key, latest === current ? { ...saved, dirty: false } : { ...latest, revision: saved.revision })
    if (latest === current) { if (auth.desktop) drafts.delete(draftKey); else drafts.set(draftKey, { ...saved, dirty: false }) }
    else drafts.set(draftKey, { ...latest, revision: saved.revision })
    if (latest !== current) throw new Error('저장 중 연결 설정이 변경되었습니다. 다시 저장하세요.')
    return saved.bindings
  }
  const identityError = !auth.desktop && auth.ready && !auth.me?.username ? new Error('로그인 사용자 정보를 확인하지 못했습니다. 화면을 새로고침한 뒤 연결 설정을 선택하세요.') : null
  return { bindings: loaded.data?.bindings ?? {}, ready, error: identityError ?? connection.error ?? loaded.error, loading: !identityReady || loaded.isPending, dirty, update, save, reload: async (discard = false) => { if (discard) drafts.delete(draftKey); if (auth.desktop) await connection.refetch(); return loaded.refetch() }, persistent: !!auth.desktop }
}
