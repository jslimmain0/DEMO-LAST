import type { TcpTransferStep } from '../api/types'

export const tcpPhaseLabel = (phase: string): string => ({ REQUEST: '요청', REQUEST_ACK: '요청 ACK', RESPONSE: '응답', RESPONSE_ACK: '응답 ACK', COMPLETE: '전송 완료' } as Record<string, string>)[phase] ?? phase
const statusLabel = (status: string): string => ({ SUCCEEDED: '완료', FAILED: '실패', SKIPPED: '생략', PLANNED: '예정' } as Record<string, string>)[status] ?? status
const modeLabel = (mode: string): string => ({ exact: 'HEX 일치', 'length-only': '길이만 수신', fields: '필드 비교', hex: '고정 HEX', message: '필드 조립' } as Record<string, string>)[mode] ?? mode

/** 업무 응답과 마지막 ACK 완료 여부를 함께 확인한다. */
export function TcpTransferSteps({ steps }: { steps: TcpTransferStep[] }) {
  if (!steps.length) return null
  return <ol aria-label="TCP 전송 단계" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 5 }}>
    {steps.map((step, index) => <li key={`${step.phase}-${index}`} style={{ border: `1px solid ${step.status === 'FAILED' ? 'var(--fl-fail)' : 'var(--fl-border)'}`, borderRadius: 'var(--fl-radius-sm)', padding: '6px 9px', fontSize: 12, display: 'grid', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <b>{tcpPhaseLabel(step.phase)}</b>
        <span style={{ color: step.status === 'FAILED' ? 'var(--fl-fail)' : step.status === 'SUCCEEDED' ? 'var(--fl-ok)' : 'var(--fl-text-muted)' }}>{statusLabel(step.status)}</span>
        {step.direction && <span style={{ color: 'var(--fl-text-muted)' }}>{step.direction === 'SEND' ? '송신' : '수신'}</span>}
        {step.status !== 'SKIPPED' && step.phase !== 'COMPLETE' && <span style={{ fontFamily: 'var(--fl-font-mono)', marginLeft: 'auto' }}>{step.actualBytes ?? 0}{step.expectedBytes != null ? ` / ${step.expectedBytes}` : ''} B</span>}
        {step.durationMs != null && <span style={{ color: 'var(--fl-text-muted)' }}>{step.durationMs}ms</span>}
      </div>
      {step.validationMode && <span style={{ color: 'var(--fl-text-muted)' }}>{modeLabel(step.validationMode)}</span>}
      {step.errorCode && <code style={{ color: 'var(--fl-fail)', overflowWrap: 'anywhere' }}>{step.errorCode}</code>}
    </li>)}
  </ol>
}
