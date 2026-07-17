import type { HttpMethod } from '../api/types'

/**
 * 노드 실행 로그 공용 조각 — RunPanel(라이브)과 Executions 상세 모달(이력)이 같은 요청/응답/출력 블록을
 * 쓰도록 통합. 복사 버튼·스타일을 한 곳에서 관리(이전엔 RunPanel 에만 복사가 있었음).
 */
export function LogBlock({ title, text }: { title: string; text: string | null | undefined }) {
  if (!text) return null
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)' }}>{title}</div>
        <button onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}) }} title={`${title} 복사`}
          style={{ fontSize: 10.5, padding: '1px 7px', border: '1px solid var(--fl-border)', borderRadius: 5, background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer' }}>복사</button>
      </div>
      <pre style={{ margin: 0, padding: 10, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', borderRadius: 'var(--fl-radius-sm)', fontFamily: 'var(--fl-font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>{text}</pre>
    </div>
  )
}

/** 요청 텍스트 첫 토큰에서 HTTP 메서드를 추출(메서드 태그용). 못 찾으면 null. */
export function methodOf(requestText: string | null | undefined): HttpMethod | null {
  const m = (requestText?.trim().split(/\s+/)[0] ?? '').toUpperCase()
  return (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m) ? m : null) as HttpMethod | null
}
