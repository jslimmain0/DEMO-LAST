import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import type { TcpMockSession } from '../api/types'
import { ui } from '../design/ui'
import { apiErrorMessage } from '../lib/apiError'
import { toast } from './toast'

function sessionRemainingMs(session: TcpMockSession, updatedAt: number, now: number): number | null {
  if (session.state !== 'waiting' || session.remainingMs == null) return null
  return Math.max(0, session.remainingMs - Math.max(0, now - updatedAt))
}

function countdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`
}

const timestamp = (iso: string) => new Date(iso).toLocaleTimeString('ko-KR', { hour12: false })
const stateLabel = { starting: '연결 준비 중', waiting: '다음 요청 대기', processing: '요청 처리 중' }

export function TcpMockSessions({ mockId, readOnly, onOpenConnection }: { mockId: string; readOnly?: boolean; onOpenConnection?: () => void }) {
  const scope = useWorkspace()
  const { mocksApi } = useApi()
  const qc = useQueryClient()
  const active = useRef(true)
  const extendBusy = useRef(false)
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  const [now, setNow] = useState(Date.now)
  const [extending, setExtending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryKey = ['mock-tcp-sessions', scope.scopeKey, mockId]
  const ready = !!mockId && !scope.loading && (scope.current.origin === 'local' || (scope.connected && !scope.remoteLoading))
  const sessions = useQuery({
    queryKey, queryFn: () => mocksApi.tcpSessions(mockId), enabled: ready && visible,
    refetchInterval: ready && visible && !extending ? 2500 : false, refetchIntervalInBackground: false, retry: false,
  })
  useEffect(() => {
    active.current = true
    const onVisibility = () => { setVisible(document.visibilityState !== 'hidden'); setNow(Date.now()) }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { active.current = false; document.removeEventListener('visibilitychange', onVisibility) }
  }, [])
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [visible])
  const extend = useMutation({
    mutationFn: async (sessionId: string) => {
      const session = sessions.data?.find(item => item.id === sessionId)
      const remaining = session ? sessionRemainingMs(session, sessions.dataUpdatedAt, Date.now()) : null
      if (!active.current || readOnly || !ready || extendBusy.current || sessions.isError || remaining == null || remaining <= 0) {
        throw new Error('대기 중인 연결만 연장할 수 있습니다. 목록을 새로고침하세요.')
      }
      if (remaining > 3540000) throw new Error('1분을 더하면 최대 대기 시간 1시간을 넘습니다.')
      extendBusy.current = true
      setExtending(sessionId); setError(null)
      await qc.cancelQueries({ queryKey, exact: true })
      if (!active.current) throw new Error('선택한 Mock이 변경되었습니다.')
      return mocksApi.extendTcpSession(mockId, sessionId, 60000)
    },
    onSuccess: updated => {
      if (!active.current) return
      const receivedAt = Date.now()
      const previousAt = qc.getQueryState(queryKey)?.dataUpdatedAt ?? receivedAt
      qc.setQueryData<TcpMockSession[]>(queryKey, previous => previous?.map(session => session.id === updated.id ? updated : {
        ...session, remainingMs: sessionRemainingMs(session, previousAt, receivedAt),
      }))
      setNow(receivedAt)
      toast('이 연결의 현재 대기 기한을 1분 연장했습니다.', 'ok')
    },
    onError: failure => {
      if (!active.current) return
      const message = apiErrorMessage(failure, '연결 연장에 실패했습니다')
      setError(message); toast(message, 'error')
    },
    onSettled: () => {
      extendBusy.current = false
      if (!active.current) return
      setExtending(null)
      void qc.invalidateQueries({ queryKey, exact: true })
    },
  })
  return (
    <section aria-label="연결된 TCP 세션" style={panel}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: 'var(--fl-font-head)', fontSize: 16, margin: 0 }}>연결 세션 {ready && sessions.data && !sessions.isError ? <span style={{ color: 'var(--fl-text-muted)', fontWeight: 500 }}>{sessions.data.length}</span> : null}</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {onOpenConnection && <button type="button" style={ui.mini} onClick={onOpenConnection}>연결 설정 보기</button>}
          <button type="button" style={ui.mini} aria-label="TCP 세션 새로고침" disabled={!ready || sessions.isFetching || extend.isPending} onClick={() => { setError(null); void sessions.refetch() }}>{sessions.isFetching ? '조회 중…' : '새로고침'}</button>
        </div>
      </div>
      <p style={hint}>이 Mock이 받은 TCP 연결입니다. 다음 요청을 기다리는 연결의 기한을 1분씩 늘릴 수 있습니다. 데이터가 오가면 기본 유휴시간으로 돌아갑니다.</p>
      {error && <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>{error}</p>}
      {!ready ? <p role="status" style={hint}>{scope.current.origin === 'server' && !scope.connected ? '서버에 연결하면 세션을 조회할 수 있습니다.' : '실행 위치를 확인하는 중…'}</p>
        : sessions.isError ? <p role="alert" style={{ ...hint, color: 'var(--fl-fail)' }}>세션을 불러오지 못했습니다. {apiErrorMessage(sessions.error, '세션 조회 실패')} 최신 상태를 확인하려면 새로고침하세요.</p>
          : sessions.isPending ? <p role="status" style={hint}>연결된 세션을 불러오는 중…</p>
            : sessions.data?.length === 0 ? <p style={hint}>현재 연결된 세션이 없습니다. 외부 앱이 이 Mock의 TCP 주소에 연결하면 여기에 표시됩니다.</p>
              : <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>{sessions.data?.map(session => {
                const remaining = sessionRemainingMs(session, sessions.dataUpdatedAt, now)
                const address = `${session.remoteAddress.includes(':') ? `[${session.remoteAddress}]` : session.remoteAddress}:${session.remotePort}`
                const canExtend = !readOnly && session.state === 'waiting' && remaining != null && remaining > 0 && remaining <= 3540000 && !extend.isPending
                const disabledReason = readOnly ? '편집 권한이 필요합니다.' : extend.isPending ? (extending === session.id ? '서버에서 연장을 확인하는 중입니다.' : '진행 중인 연장이 끝나면 사용할 수 있습니다.') : session.state !== 'waiting' ? '다음 요청을 기다릴 때 연장할 수 있습니다.' : remaining === 0 ? '기한이 지나 종료 여부를 확인하고 있습니다.' : remaining != null && remaining > 3540000 ? '남은 기한은 최대 1시간입니다. 1분을 추가하려면 잠시 기다리세요.' : ''
                return <article key={session.id} aria-label={`TCP 세션 ${session.id}`} style={sessionRow}>
                  <div style={{ flex: '1 1 280px', minWidth: 0, display: 'grid', gap: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <code style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{address}</code>
                      <span style={{ fontSize: 12, color: session.state === 'waiting' ? 'var(--fl-ok)' : 'var(--fl-text-muted)' }}>{stateLabel[session.state]}</span>
                      <span title={session.id} style={{ fontSize: 11, color: 'var(--fl-text-muted)' }}>#{session.id.slice(0, 8)}</span>
                    </div>
                    <div style={{ ...hint, margin: 0, display: 'flex', gap: '4px 14px', flexWrap: 'wrap', fontVariantNumeric: 'tabular-nums' }}>
                      <span title={new Date(session.connectedAt).toLocaleString('ko-KR')}>연결 {timestamp(session.connectedAt)}</span>
                      <span title={new Date(session.lastActivityAt).toLocaleString('ko-KR')}>마지막 활동 {timestamp(session.lastActivityAt)}</span>
                      <span>수신 전문 {session.receivedMessages}개</span>
                      <span>기본 유휴 {countdown(session.idleTimeoutMs)}</span>
                    </div>
                    {disabledReason && <p style={{ ...hint, margin: 0 }}>{disabledReason}</p>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flex: '0 0 auto', maxWidth: '100%', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 88, textAlign: 'right' }}>{remaining == null ? session.state === 'starting' ? '연결 준비 중' : '처리 후 대기 시작' : remaining === 0 ? '종료 확인 중' : `${countdown(remaining)} 남음`}</span>
                    <button type="button" style={{ ...ui.mini, minWidth: 83 }} aria-label={`세션 ${session.id} 1분 연장`} disabled={!canExtend} title={disabledReason || '현재 대기 기한에 1분 추가 · 지금부터 최대 1시간'} onClick={() => { if (!extendBusy.current) extend.mutate(session.id) }}>{extending === session.id ? '연장 중…' : '+1분 연장'}</button>
                  </div>
                </article>
              })}</div>}
      <p style={{ ...hint, fontSize: 11, marginBottom: 0 }}>기한은 지금부터 최대 1시간까지 연장됩니다. 상대 앱이 연결을 끊거나 Mock을 중지·변경하면 연장 시간과 관계없이 종료됩니다.</p>
    </section>
  )
}

const panel: CSSProperties = { padding: 18, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius)', background: 'var(--fl-surface)' }
const hint: CSSProperties = { fontSize: 12, color: 'var(--fl-text-muted)', lineHeight: 1.6, marginTop: 6 }
const sessionRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 12, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)' }
