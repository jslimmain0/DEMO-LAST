import { useState } from 'react'
import type { ExecutionDetail } from '../api/types'
import { StatusBadge } from '../components/StatusBadge'
import { MethodTag } from '../components/MethodTag'
import { duration } from '../lib/format'
import type { HttpMethod } from '../api/types'

export function RunPanel({
  execution,
  running,
  onClose,
  height = 260,
}: {
  execution: ExecutionDetail | null
  running: boolean
  onClose: () => void
  height?: number
}) {
  const [openId, setOpenId] = useState<string | null>(null)

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
        <button onClick={onClose} aria-label="로그 닫기" style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer', fontSize: 16 }}>×</button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {running && (
          <div role="status" aria-live="polite" style={{ padding: 16, color: 'var(--fl-text-muted)', fontSize: 13 }}>
            {execution?.pendingForm
              ? '폼 전송 창 대기 중… (팝업에서 완료하거나 창을 닫으면 진행됩니다)'
              : execution?.pendingClient
                ? `브라우저(클라이언트)에서 직접 호출 중… — ${execution.pendingClient.method} ${execution.pendingClient.url}`
                : '실행 중… (완료되면 결과가 표시됩니다)'}
          </div>
        )}
        {!running && !execution && (
          <div style={{ padding: 16, color: 'var(--fl-text-muted)', fontSize: 13 }}>아직 실행하지 않았습니다. ▶ 실행을 눌러보세요.</div>
        )}
        {execution && execution.nodes.map((nd) => {
          const open = openId === nd.id
          return (
            <div key={nd.id} style={{ borderBottom: '1px solid var(--fl-border)' }}>
              <button
                onClick={() => setOpenId(open ? null : nd.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 14px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
              >
                <span style={{ width: 18, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)', fontSize: 11 }}>{nd.seq}</span>
                <StatusBadge status={nd.status} />
                {nd.nodeType === 'http' && nd.httpStatus != null && <MethodTag method={'GET' as HttpMethod} />}
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

function LogBlock({ title, text }: { title: string; text: string | null | undefined }) {
  if (!text) return null
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)', marginBottom: 4 }}>{title}</div>
      <pre style={{ margin: 0, padding: 10, background: 'var(--fl-surface-2)', borderRadius: 'var(--fl-radius-sm)', fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 160, overflow: 'auto' }}>{text}</pre>
    </div>
  )
}
