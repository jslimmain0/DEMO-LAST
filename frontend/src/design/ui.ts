import type { CSSProperties } from 'react'

// 공용 컨트롤 스타일. 화면마다 따로 만들던 버튼 스타일을 여섯 변형으로 묶는다.
// 호버·눌림·포커스·비활성은 index.css 의 전역 button 규칙이 맡는다(인라인으로는 표현 불가).

const base: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  minHeight: 34, padding: '0 14px', borderRadius: 'var(--fl-radius-sm)',
  font: 'inherit', fontSize: 13, fontWeight: 600, lineHeight: 1.2, whiteSpace: 'nowrap',
  cursor: 'pointer', boxSizing: 'border-box',
}

const primary: CSSProperties = { ...base, border: '1px solid transparent', background: 'var(--fl-action-primary-bg)', color: 'var(--fl-action-primary-ink)' }
const secondary: CSSProperties = { ...base, border: '1px solid var(--fl-control-border-soft)', background: 'var(--fl-surface)', color: 'var(--fl-text)' }
const ghost: CSSProperties = { ...base, border: '1px solid transparent', background: 'transparent', color: 'var(--fl-text-soft)' }
const danger: CSSProperties = { ...base, border: '1px solid color-mix(in srgb, var(--fl-fail) 40%, var(--fl-border))', background: 'var(--fl-surface)', color: 'var(--fl-fail)' }
// 목록 끝의 '+ 추가' 같은 보조 버튼 — 점선 상자 대신 강조색 글자
const dashed: CSSProperties = { ...base, minHeight: 30, padding: '0 8px', border: '1px solid transparent', background: 'transparent', color: 'var(--fl-primary)', justifyContent: 'flex-start' }
const sm: CSSProperties = { minHeight: 28, padding: '0 10px', fontSize: 12 }
const icon: CSSProperties = { ...ghost, width: 30, height: 30, minHeight: 0, padding: 0, color: 'var(--fl-text-muted)' }

export const ui = {
  primary,
  secondary,
  ghost,
  danger,
  dashed,
  /** 작은 보조 버튼(표·행 안) */
  mini: { ...secondary, ...sm, fontWeight: 500 } as CSSProperties,
  /** 아이콘만 있는 정사각 버튼 */
  icon,
  /** 대화상자 닫기(×) */
  close: { ...icon, width: 28, height: 28, fontSize: 16 } as CSSProperties,
} as const
