import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthContext'
import { desktopApi, type DesktopUpdateStatus } from '../auth/desktop'
import { apiErrorMessage } from '../lib/apiError'
import { ActionButton } from './ActionButton'
import { ServerInstallCard } from './ServerInstallCard'

const labels: Record<DesktopUpdateStatus['phase'], string> = {
  idle: '아직 확인하지 않았습니다', checking: '배포 버전 확인 중', available: '새 버전이 있습니다',
  current: '설치 가능한 새 버전 없음', downloading: '설치파일 다운로드 중', ready: '설치파일 검증 완료',
  installing: 'Windows 앱에서 설치 진행 중', error: '업데이트를 완료하지 못했습니다',
}
const statusKey = ['desktop', 'update'] as const
export function DesktopUpdateCard() {
  const { desktop } = useAuth()
  const qc = useQueryClient()
  const status = useQuery({ queryKey: statusKey, queryFn: desktopApi.updateStatus, enabled: !!desktop, retry: false, refetchInterval: desktop ? 1500 : false })
  const update = (data: DesktopUpdateStatus) => { qc.setQueryData(statusKey, data) }
  const check = useMutation({ mutationFn: desktopApi.checkUpdate, onSuccess: update })
  const download = useMutation({ mutationFn: desktopApi.downloadUpdate, onSuccess: update })
  const open = useMutation({ mutationFn: desktopApi.openUpdateWindow })
  if (!desktop) return <><p>Windows 앱 업데이트는 설치된 PC에서 확인합니다.</p><p style={{ color: 'var(--fl-text-muted)', fontSize: 13 }}>서버 화면에서는 이 PC의 설치 버전이나 실행 중 작업을 확인할 수 없습니다. Windows 앱을 열어 설정의 앱 업데이트를 사용하세요.</p><ServerInstallCard /></>
  const info = status.data
  const busy = check.isPending || download.isPending || ['checking', 'downloading', 'installing'].includes(info?.phase ?? '')
  const failure = check.error || download.error || open.error
  return <section aria-label="Windows 앱 업데이트 상태" style={{ fontSize: 13, lineHeight: 1.6 }}>
    <h3 style={{ fontSize: 16, margin: '0 0 12px' }}>Windows 앱 업데이트</h3>
    <p style={{ color: 'var(--fl-text-muted)' }}>회사 서버에서 제공하는 새 버전을 확인하고 이 PC의 FlowLink 앱을 업데이트합니다.</p>
    {status.isPending && <p role="status">업데이트 상태를 불러오는 중…</p>}
    {status.isError && <p role="alert">상태를 확인하지 못했습니다. {apiErrorMessage(status.error)}</p>}
    {info && <div style={{ padding: 14, border: '1px solid var(--fl-border)', borderRadius: 8, background: 'var(--fl-surface-2)', overflowWrap: 'anywhere' }}>
      <strong role="status">{labels[info.phase]}</strong>
      <p style={{ margin: '8px 0' }}>설치 버전 · {info.currentVersion}<br />배포 버전 · {info.availableVersion ?? '확인되지 않음'}</p>
      {info.message && <p style={{ margin: '8px 0' }}>{info.message}</p>}
      {info.phase === 'downloading' && <><progress aria-label="설치파일 다운로드" value={info.totalBytes > 0 ? info.downloadedBytes : undefined} max={info.totalBytes > 0 ? info.totalBytes : undefined} style={{ width: '100%' }} /><div>{Math.round(info.downloadedBytes / 1024 / 1024)} MB{info.totalBytes > 0 ? ` / ${Math.round(info.totalBytes / 1024 / 1024)} MB` : ''}</div></>}
      {info.releaseNotes && <details><summary>변경 내용</summary><p style={{ whiteSpace: 'pre-wrap' }}>{info.releaseNotes}</p></details>}
    </div>}
    {failure && <p role="alert" style={{ color: 'var(--fl-fail)' }}>{apiErrorMessage(failure)}</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
      <ActionButton disabled={busy} onClick={() => check.mutate()}>업데이트 확인</ActionButton>
      <ActionButton disabled={status.isError || busy || info?.phase !== 'available'} onClick={() => download.mutate()}>설치파일 다운로드</ActionButton>
      <ActionButton variant="primary" disabled={status.isError || open.isPending || info?.phase !== 'ready'} onClick={() => open.mutate()}>Windows 앱에서 설치</ActionButton>
      {status.isError && <ActionButton onClick={() => void status.refetch()}>상태 다시 불러오기</ActionButton>}
    </div>
    <p style={{ color: 'var(--fl-text-muted)' }}>다운로드는 작업 중에도 할 수 있습니다. 설치는 Windows 앱의 확인 창에서 진행하며 앱이 다시 시작됩니다. 실행·콜백 대기·Mock 수신과 모든 열린 화면의 미저장 작업을 먼저 확인하세요.</p>
  </section>
}
