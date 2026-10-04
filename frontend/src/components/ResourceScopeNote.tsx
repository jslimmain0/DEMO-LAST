import { useWorkspace } from '../app/WorkspaceContext'

/** 자원 편집 화면에서 실제 저장 위치를 계속 보여준다. */
export function ResourceScopeNote() {
  const { current } = useWorkspace()
  return <div title={`${current.origin === 'local' ? '내 PC' : '서버'} · ${current.name}`} style={{ fontSize: 12, color: 'var(--fl-text-muted)', marginBottom: 10, overflowWrap: 'anywhere' }}>
    저장 위치 <b style={{ color: 'var(--fl-text)' }}>{current.origin === 'local' ? '내 PC' : '서버'} · {current.name}</b>
  </div>
}
