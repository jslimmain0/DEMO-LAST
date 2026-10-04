import { useQuery } from '@tanstack/react-query'
import { http } from '../api/client'
import { apiErrorMessage } from '../lib/apiError'
import { ActionButton } from './ActionButton'

interface Distribution {
  serverUrl: string; mcpUrl: string; serverVersion: string
  releaseStatus: 'AVAILABLE' | 'MISSING' | 'INVALID' | 'INCOMPATIBLE'
  automaticUpdateAllowed: boolean
  releaseMessage: string
  release: { version: string; releaseNotes: string | null; size: number; sha256: string } | null
  version: string | null; installerUrl: string | null; available: boolean
}
export function ServerInstallCard({ compact = false }: { compact?: boolean }) {
  const q = useQuery({ queryKey: ['distribution'], queryFn: () => http.get<Distribution>('/distribution').then(r => r.data), retry: false })
  const info = q.data
  return <section aria-label="Windows 앱 다운로드" style={{ textAlign: 'left', fontSize: 13, lineHeight: 1.6, padding: compact ? '12px 8px' : 14, marginTop: 16, borderTop: '1px solid var(--fl-border)', overflowWrap: 'anywhere' }}>
    {q.isPending && <p role="status">배포 정보를 확인하는 중…</p>}
    {q.isError && <><p role="alert">배포 정보를 확인하지 못했습니다. {apiErrorMessage(q.error)}</p><ActionButton onClick={() => void q.refetch()}>다시 확인</ActionButton></>}
    {info && <>
      <div>서버 버전 · {info.serverVersion || '확인되지 않음'}</div>
      {info.available && info.installerUrl && info.release ? <><a href={info.installerUrl} style={{ color: 'var(--fl-primary)', fontWeight: 700 }}>Windows 앱 다운로드 · {info.release.version}</a><div style={{ color: 'var(--fl-text-muted)' }}>설치파일 · {Math.round(info.release.size / 1024 / 1024)} MB</div></> : <p role="status">{info.releaseMessage || (info.releaseStatus === 'MISSING' ? '검증 가능한 배포 정보가 없습니다. 서버 관리자에게 설치파일 배포를 요청하세요.' : '현재 서버에서 설치 가능한 앱 배포 정보를 확인하지 못했습니다.')}</p>}
      {info.releaseStatus === 'INCOMPATIBLE' && <p role="alert" style={{ color: 'var(--fl-waiting)' }}>{info.releaseMessage || '현재 서버와의 호환 조합이 확인되지 않았습니다.'} 수동 다운로드는 가능하지만 자동 설치는 허용되지 않습니다.</p>}
      {!compact && <><p>개인 작업은 PC에 저장됩니다. 회사 팀 작업은 서버에 연결해서 사용합니다.</p><div>서버: {info.serverUrl}</div><div>MCP 안내 주소: {info.mcpUrl}</div><p style={{ marginBottom: 0 }}>설치 후 Windows 앱에서 회사 서버 연결 정보를 확인하고 로그인하세요. IDE 연결은 회사의 MCP 안내를 따르세요.</p></>}
    </>}
  </section>
}
