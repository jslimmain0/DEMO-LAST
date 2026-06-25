import type { HttpMethod } from '../api/types'

export const CAT_COLOR: Record<string, string> = {
  auth: 'var(--fl-cat-auth)',
  bank: 'var(--fl-cat-bank)',
  card: 'var(--fl-cat-card)',
  generic: 'var(--fl-cat-generic)',
  set: 'var(--fl-cat-set)',
  if: 'var(--fl-cat-if)',
  wait: 'var(--fl-cat-wait)',
  start: 'var(--fl-cat-start)',
  end: 'var(--fl-cat-end)',
}

export const METHOD_COLOR: Record<HttpMethod, string> = {
  GET: 'var(--fl-get)',
  POST: 'var(--fl-post)',
  PUT: 'var(--fl-put)',
  PATCH: 'var(--fl-patch)',
  DELETE: 'var(--fl-delete)',
  HEAD: 'var(--fl-head)',
}

export function catColor(cat: string | undefined): string {
  return CAT_COLOR[cat ?? 'generic'] ?? CAT_COLOR.generic
}

// 색 단독 금지 — 아이콘+텍스트 동반 (1.4.1)
export function typeIcon(type: string): string {
  switch (type) {
    case 'start': return '▶'
    case 'end': return '■'
    case 'set': return '𝑥'
    case 'if': return '◇'
    case 'wait': return '⏸'
    default: return '↯'
  }
}

export function typeLabel(type: string): string {
  switch (type) {
    case 'start': return '시작'
    case 'end': return '끝'
    case 'set': return '변수'
    case 'if': return '조건'
    case 'wait': return '대기'
    case 'http': return 'HTTP'
    default: return type
  }
}
