import type { HttpMethod, NodeExecutionView } from '../api/types'
import { useState } from 'react'
import { toast } from './toast'

/** 실시간 응답의 파싱된 출력과 실행 이력의 원문 출력을 모두 표시한다. */
export function outputText(node: Pick<NodeExecutionView, 'output' | 'outputJson'>): string | null {
  return node.output != null ? JSON.stringify(node.output, null, 2) : node.outputJson ?? null
}

/**
 * 노드 실행 로그 공용 조각 — RunPanel(라이브)과 Executions 상세 모달(이력)이 같은 요청/응답/출력 블록을
 * 쓰도록 통합. 복사 버튼·스타일을 한 곳에서 관리(이전엔 RunPanel 에만 복사가 있었음).
 */
export function LogBlock({ title, text }: { title: string; text: string | null | undefined }) {
  const [wrap, setWrap] = useState(true)
  if (!text) return null
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      toast(`${title}을 복사했습니다.`, 'ok')
    } catch { toast('복사하지 못했습니다. 본문을 직접 선택해서 복사하세요.', 'error') }
  }
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--fl-text-muted)' }}>{title}</div>
        <button type="button" onClick={() => setWrap(value => !value)} aria-label={`${title} 본문 줄바꿈`} aria-pressed={wrap}
          style={{ fontSize: 11, padding: '1px 7px', border: '1px solid var(--fl-border)', borderRadius: 6, background: wrap ? 'var(--fl-surface-2)' : 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer' }}>줄바꿈</button>
        <button type="button" onClick={() => void copy()} aria-label={`${title} 복사`} title={`${title} 복사`}
          style={{ fontSize: 11, padding: '1px 7px', border: '1px solid var(--fl-border)', borderRadius: 6, background: 'transparent', color: 'var(--fl-text-muted)', cursor: 'pointer' }}>복사</button>
      </div>
      <pre tabIndex={0} aria-label={`${title} 본문`} style={{ margin: 0, padding: 10, background: 'var(--fl-surface-2)', color: 'var(--fl-text)', borderRadius: 'var(--fl-radius-sm)', fontFamily: 'var(--fl-font-mono)', fontSize: 12, lineHeight: 1.6, whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal', maxHeight: 240, minWidth: 0, maxWidth: '100%', overflow: 'auto' }}>{text}</pre>
    </div>
  )
}

/** 요청 텍스트 첫 토큰에서 HTTP 메서드를 추출(메서드 태그용). 못 찾으면 null. */
export function methodOf(requestText: string | null | undefined): HttpMethod | null {
  const m = (requestText?.trim().split(/\s+/)[0] ?? '').toUpperCase()
  return (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(m) ? m : null) as HttpMethod | null
}
