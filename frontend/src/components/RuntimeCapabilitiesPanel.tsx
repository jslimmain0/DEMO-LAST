import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWorkspace } from '../app/WorkspaceContext'
import { useAuth } from '../auth/AuthContext'
import { apiErrorMessage } from '../lib/apiError'
import { ui } from '../design/ui'
import { FRONTEND_MOCK } from '../lib/frontendMock'

const labels: Record<string, string> = { transactionFraming: '거래별 경계', transactionAck: '거래별 ACK', ackLengthOnly: 'ACK 길이 수신', ackMessageTemplates: 'ACK 레이아웃 송신', ackFieldValidation: 'ACK 필드 비교', binaryIntegers: '바이너리 정수', mockPreview: 'Mock 미리보기', lengthAdjustment: '길이 보정', fixedFraming: '고정 길이', delimiterFraming: '끝 구분자', responseFraming: '응답별 경계', connectionReuse: '연결 유지', approvedCodecs: '승인 코덱' }
export function RuntimeCapabilitiesPanel() {
  const { agentApi, connected, remoteKey } = useWorkspace()
  const { desktop } = useAuth()
  const serverApi = useMemo(() => agentApi('server', 'public'), [agentApi])
  const localApi = useMemo(() => agentApi('local', 'public'), [agentApi])
  const server = useQuery({ queryKey: ['runtime-capabilities', 'server', remoteKey], queryFn: serverApi.runtimeApi.capabilities, enabled: connected, retry: false, staleTime: 60_000 })
  const local = useQuery({ queryKey: ['runtime-capabilities', 'local'], queryFn: localApi.runtimeApi.capabilities, enabled: !!desktop, retry: false, staleTime: 60_000 })
  return <details style={{ margin: '12px 0', fontSize: 12, lineHeight: 1.7, overflowWrap: 'anywhere' }}><summary>서버 · 내 PC 기능 지원 확인</summary>
    <p style={{ color: 'var(--fl-text-muted)' }}>{FRONTEND_MOCK ? '프론트 Mock의 합성 지원 상태입니다. 실제 실행기 호환성은 이 화면으로 검증하지 않습니다.' : '실제 실행기에서 조회한 정보입니다.'} 정의 저장 가능 여부와 이 PC의 실행 가능 여부는 다르며, 조회 실패·PC 미연결은 지원으로 추정하지 않습니다.</p>
    {(['server', 'local'] as const).map(host => {
      const query = host === 'server' ? server : local
      const enabled = host === 'server' ? connected : !!desktop
      return <div key={host} style={{ padding: 10, marginTop: 8, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)' }}><strong>{host === 'server' ? '서버 실행기' : '내 PC 실행기'} · {!enabled ? '미연결 · 확인 불가' : query.isError ? '조회 실패 · 확인 불가' : query.isPending ? '확인 중…' : query.data?.installedVersion ?? '확인 불가'}</strong>
        {query.isError && <p role="alert">{apiErrorMessage(query.error)}</p>}
        {enabled && query.isSuccess && query.data && <><p>schemaVersion · {query.data.schemaVersions.join(', ')} · 확인 {new Date(query.data.checkedAt).toLocaleString()}</p><div>{Object.entries(query.data.features).map(([key, state]) => <div key={key}>{labels[key] ?? key} · {state === 'supported' ? '지원' : state === 'unsupported' ? '미지원' : '확인 불가'}</div>)}</div><p>전문 상한 {query.data.limits.maxWireBytes} B · ACK 상한 {query.data.limits.maxAckBytes} B · 유휴 {query.data.limits.minIdleTimeoutMs / 1000}~{query.data.limits.maxIdleTimeoutMs / 1000}초</p></>}
        {enabled && <button style={ui.mini} disabled={query.isFetching} onClick={() => void query.refetch()}>기능 다시 확인</button>}
      </div>
    })}
  </details>
}
