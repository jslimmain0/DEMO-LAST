import type { CompilationReport, ProtocolValidation } from '../api/types'
import { apiErrorMessage } from '../lib/apiError'

export function ProtocolRequestError({ error }: { error: unknown }) {
  const body = (error as { response?: { data?: { code?: string; fieldPath?: string; repairHint?: string; errors?: ProtocolValidation[] } } })?.response?.data
  return <div><p role="alert" style={{ color: 'var(--fl-fail)', fontSize: 12 }}>{body?.code && `${body.code} · `}{apiErrorMessage(error)}</p>
    {body?.fieldPath && <p style={{ fontSize: 12, overflowWrap: 'anywhere' }}><code>{body.fieldPath}</code>{body.repairHint && ` · ${body.repairHint}`}</p>}
    {Array.isArray(body?.errors) && <ValidationMessages errors={body.errors} />}
  </div>
}

export function ValidationMessages({ errors }: { errors: ProtocolValidation[] }) {
  return <>{errors.map((error, index) => <div role="alert" key={index} style={{ color: 'var(--fl-fail)', fontSize: 12, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
    {error.code && <b>{error.code} · </b>}{(error.path || error.field) && <code>{error.path || error.field} · </code>}{error.message}{error.repairHint && <div>{error.repairHint}</div>}
  </div>)}</>
}
export function CompilationFeedback({ report }: { report: CompilationReport }) {
  return <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.7, minWidth: 0, overflowWrap: 'anywhere' }}>
    <b role="status">{report.valid ? '정의 검증 완료 · 저장·전송하지 않았습니다.' : '정의를 확인하세요'}</b>
    <ValidationMessages errors={report.errors ?? []} />
    {(report.warnings ?? []).map((warning, index) => <p key={index}>{warning}</p>)}
    {(report.requiredCapabilities ?? []).length > 0 && <p>필요 기능 · {report.requiredCapabilities.join(', ')}</p>}
    <details><summary>길이·ACK 계획·자원 의존성</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(report.compiledSummary, null, 2)}</pre></details>
  </div>
}
