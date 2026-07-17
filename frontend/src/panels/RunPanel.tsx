import { useEffect, useState } from 'react'
import type { ExecutionDetail } from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { MethodTag } from '../components/MethodTag'
import { LogBlock, methodOf } from '../components/NodeExecutionLog'
import { duration } from '../lib/format'

/** wait(콜백 대기) 진행 상태 — Editor 실행 루프가 채운다. */
export interface WaitStatus {
  nodeId: string
  nodeName?: string
  receiveUrl?: string | null
  deadline: number // epoch ms — 카운트다운 표시용
}

export function RunPanel({
  execution,
  running,
  waitStatus = null,
  onStop,
  onClose,
  height = 260,
}: {
  execution: ExecutionDetail | null
  running: boolean
  waitStatus?: WaitStatus | null
  onStop?: () => void
  onClose: () => void
  height?: number
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'ok' | 'fail' | 'skip'>('all')
  const matchFilter = (s: string) => filter === 'all'
    || (filter === 'ok' && s === 'SUCCEEDED') || (filter === 'fail' && s === 'FAILED') || (filter === 'skip' && s === 'SKIPPED')
  const visibleNodes = (execution?.nodes ?? []).filter((nd) => matchFilter(nd.status))

  // 실패 시 첫 실패 노드를 자동으로 펼쳐 실패 지점을 바로 보여준다(긴 그래프에서 손으로 찾을 필요 없이)
  useEffect(() => {
    if (execution?.status === 'FAILED') {
      const failed = execution.nodes.find((n) => n.status === 'FAILED')
      if (failed) setOpenId(failed.id)
    }
    // 실행 id/상태가 바뀔 때만 — nodes 변경마다 재실행 불필요
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [execution?.id, execution?.status])

  // 실행 로그 전체를 텍스트로 내보내기(다운로드) — 오류 리포트·회귀 비교용
  const exportLog = () => {
    if (!execution) return
    const lines = [`# 실행 ${execution.id} · ${execution.status}${execution.error ? ` · ${execution.error}` : ''}`]
    for (const nd of execution.nodes) {
      lines.push(`\n## [${nd.status}] ${nd.nodeName || nd.nodeId}${nd.httpStatus != null ? ` · HTTP ${nd.httpStatus}` : ''}${nd.durationMs != null ? ` · ${nd.durationMs}ms` : ''}`)
      if (nd.requestText) lines.push(`요청:\n${nd.requestText}`)
      if (nd.responseText) lines.push(`응답:\n${nd.responseText}`)
      if (nd.output != null) lines.push(`출력:\n${JSON.stringify(nd.output, null, 2)}`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `run-${execution.id.slice(0, 8)}.txt`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section
      aria-label="실행 로그"
      style={{
        height,
        flexShrink: 0,
        background: 'var(--fl-surface)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid var(--fl-border)' }}>
        <strong style={{ fontSize: 13 }}>실행 로그</strong>
        {execution && <StatusBadge status={execution.status} />}
        {execution?.error && <span style={{ fontSize: 12, color: 'var(--fl-fail)' }}>{execution.error}</span>}
        {running && onStop && (
          <button onClick={onStop} title="실행 중단" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', border: '1px solid var(--fl-fail)', borderRadius: 'var(--fl-radius-pill)', background: 'transparent', color: 'var(--fl-fail)', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
            ⏹ 중단
          </button>
        )}
        {execution && execution.nodes.length > 0 && (
          <div style={{ marginLeft: running && onStop ? 12 : 'auto', display: 'flex', gap: 2 }}>
            {([['all', '전체'], ['ok', '성공'], ['fail', '실패'], ['skip', '건너뜀']] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => setFilter(k)} style={{ padding: '3px 8px', fontSize: 11.5, border: '1px solid var(--fl-border)', borderRadius: 6, cursor: 'pointer', background: filter === k ? 'var(--fl-primary)' : 'transparent', color: filter === k ? '#fff' : 'var(--fl-text-muted)' }}>{lbl}</button>
            ))}
            <button onClick={exportLog} title="실행 로그 전체 내보내기(.txt)" style={{ padding: '3px 8px', fontSize: 11.5, border: '1px solid var(--fl-border)', borderRadius: 6, cursor: 'pointer', background: 'transparent', color: 'var(--fl-text-muted)' }}>⬇ 내보내기</button>
          </div>
        )}
        <button onClick={onClose} aria-label="로그 닫기" style={{ marginLeft: execution && execution.nodes.length > 0 ? 8 : (running && onStop ? 0 : 'auto'), border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }}>×</button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {running && (
          waitStatus ? (
            <WaitBanner status={waitStatus} />
          ) : (
            <div role="status" aria-live="polite" style={{ padding: 16, color: 'var(--fl-text-muted)', fontSize: 13 }}>
              {execution?.pendingInput
                ? `사용자 입력 대기 중… — ${execution.pendingInput.nodeName || execution.pendingInput.nodeId} (입력 창에 값을 넣고 확인하면 진행됩니다)`
                : execution?.pendingForm
                ? '팝업을 열고 폼을 제출하는 중…'
                : execution?.pendingClient
                  ? `브라우저(클라이언트)에서 직접 호출 중… — ${execution.pendingClient.method} ${execution.pendingClient.url}`
                  : '실행 중… (완료되면 결과가 표시됩니다)'}
            </div>
          )
        )}
        {!running && !execution && (
          <div style={{ padding: 16, color: 'var(--fl-text-muted)', fontSize: 13 }}>아직 실행하지 않았습니다. ▶ 실행을 눌러보세요.</div>
        )}
        {execution && execution.nodes.length > 0 && visibleNodes.length === 0 && (
          <div style={{ padding: 16, color: 'var(--fl-text-muted)', fontSize: 13 }}>이 필터에 해당하는 노드가 없습니다.</div>
        )}
        {execution && visibleNodes.map((nd) => {
          const open = openId === nd.id
          return (
            <div key={nd.id} style={{ borderBottom: '1px solid var(--fl-border)' }}>
              <button
                onClick={() => setOpenId(open ? null : nd.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ width: 18, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{nd.seq}</span>
                <StatusBadge status={nd.status} />
                {nd.nodeType === 'http' && nd.httpStatus != null && methodOf(nd.requestText) && <MethodTag method={methodOf(nd.requestText)!} />}
                <span style={{ fontSize: 13, fontWeight: 500 }}>{nd.nodeName || nd.nodeId}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, color: 'var(--fl-text-muted)', fontSize: 12, fontFamily: 'var(--fl-font-mono)' }}>
                  {nd.httpStatus != null && <span>{nd.httpStatus}</span>}
                  {nd.durationMs != null && <span>{duration(nd.durationMs)}</span>}
                  <span aria-hidden>{open ? '▾' : '▸'}</span>
                </span>
              </button>
              {open && (
                <div style={{ padding: '4px 14px 14px 42px', display: 'grid', gap: 10 }}>
                  <LogBlock title="요청" text={nd.requestText} />
                  <LogBlock title="응답" text={nd.responseText} />
                  {nd.output != null && <LogBlock title="출력" text={JSON.stringify(nd.output, null, 2)} />}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** 콜백 대기 배너 — 실시간 카운트다운(0.3초 갱신) + 수신 URL(클릭 전체선택·복사). */
function WaitBanner({ status }: { status: WaitStatus }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 300)
    return () => clearInterval(t)
  }, [])
  const remain = Math.max(0, Math.ceil((status.deadline - now) / 1000))
  return (
    <div role="status" aria-live="polite" style={{ padding: '14px 16px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fl-waiting)', fontWeight: 700 }}>
        <span className="fl-wait-dot" aria-hidden />
        {status.nodeName || status.nodeId} — 대기 중 ({remain}초 남음)
      </div>
      {status.receiveUrl && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11.5, color: 'var(--fl-text-muted)', flexShrink: 0 }}>이 URL로 콜백을 보내면 진행됩니다:</span>
          <input
            readOnly
            value={status.receiveUrl}
            onFocus={(e) => e.currentTarget.select()}
            style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontFamily: 'var(--fl-font-mono)', fontSize: 11.5 }}
          />
          <button
            onClick={() => { void navigator.clipboard?.writeText(status.receiveUrl ?? '').catch(() => {}) }}
            title="수신 URL 복사"
            style={{ flexShrink: 0, width: 28, height: 28, border: '1px solid var(--fl-border)', borderRadius: 6, background: 'var(--fl-surface)', color: 'var(--fl-primary)', cursor: 'pointer' }}
          >⧉</button>
        </div>
      )}
    </div>
  )
}



