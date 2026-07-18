import type { HttpMethod } from '../api/types'

export const CAT_COLOR: Record<string, string> = {
  auth: 'var(--fl-cat-auth)',
  bank: 'var(--fl-cat-bank)',
  card: 'var(--fl-cat-card)',
  generic: 'var(--fl-cat-generic)',
  set: 'var(--fl-cat-set)',
  if: 'var(--fl-cat-if)',
  assert: 'var(--fl-cat-assert)',
  form: 'var(--fl-cat-form)',
  input: 'var(--fl-cat-input)',
  wait: 'var(--fl-cat-wait)',
  start: 'var(--fl-cat-start)',
  end: 'var(--fl-cat-end)',
  transform: 'var(--fl-patch)',
  tcp: 'var(--fl-post)',
  switch: 'var(--fl-put)',
  note: '#eab308',
  group: '#94a3b8',
}

// 주석(메모/영역 박스) 색 팔레트 — 라이트/다크 겸용 반투명 배경 + 진한 테두리/제목색
export const ANNO_COLORS: Record<string, { label: string; bg: string; border: string }> = {
  yellow: { label: '노랑', bg: 'rgba(234,179,8,.14)', border: '#ca9a04' },
  blue: { label: '파랑', bg: 'rgba(59,130,246,.12)', border: '#3b82f6' },
  pink: { label: '분홍', bg: 'rgba(236,72,153,.12)', border: '#ec4899' },
  green: { label: '초록', bg: 'rgba(34,197,94,.12)', border: '#16a34a' },
  gray: { label: '회색', bg: 'rgba(148,163,184,.14)', border: '#94a3b8' },
}

export function annoColor(key: string | undefined, fallback = 'yellow') {
  return ANNO_COLORS[key ?? fallback] ?? ANNO_COLORS[fallback]
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
    case 'assert': return '✓'
    case 'form': return '▤'
    case 'input': return '⌨'
    case 'wait': return '⏸'
    case 'transform': return '⚙'
    case 'tcp': return '⇄'
    case 'switch': return '⑂'
    case 'note': return '✎'
    case 'group': return '▢'
    default: return '↯'
  }
}

export function typeLabel(type: string): string {
  switch (type) {
    case 'start': return '시작'
    case 'end': return '끝'
    case 'set': return '변수 지정'
    case 'if': return '조건 분기'
    case 'assert': return '값 검증'
    case 'form': return '폼·결제창'
    case 'input': return '사용자 입력'
    case 'wait': return '콜백 대기'
    case 'transform': return '데이터 변환'
    case 'tcp': return 'TCP 전문'
    case 'switch': return '경로 전환'
    case 'note': return '메모'
    case 'group': return '영역 박스'
    case 'http': return 'API 호출'
    default: return type
  }
}
