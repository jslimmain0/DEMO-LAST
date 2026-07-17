import { useEffect, useState } from 'react'

/**
 * 배경색 위에 읽기 좋은 전경색(흰/진한 글자)을 WCAG 상대휘도로 고른다.
 * 색 배지·이름표가 특정 테마/특정 색(초록·주황·청록 등)에서 흰 글자로 잘 안 보이던 문제 해결.
 * hex(`#059669`) 또는 CSS 변수(`var(--fl-cat-set)`, 테마별 값) 모두 허용.
 */
const DARK_INK = '#1c1c1f'
const LIGHT_INK = '#ffffff'
const WHITE_LUM = 1

function parseHex(color: string): [number, number, number] | null {
  let h = color.trim()
  if (h.startsWith('var(')) {
    const name = h.slice(4, h.indexOf(')')).trim()
    h = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }
  h = h.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return null
  const n = parseInt(h, 16)
  if (Number.isNaN(n)) return null
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function relLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(l1: number, l2: number): number {
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

const DARK_LUM = relLuminance(parseHex(DARK_INK)!)

/** 배경색에 대비가 큰 전경색을 반환. 파싱 실패 시 흰색 폴백. */
export function readableText(bg: string): string {
  const rgb = parseHex(bg)
  if (!rgb) return LIGHT_INK
  const l = relLuminance(rgb)
  return contrast(l, DARK_LUM) >= contrast(l, WHITE_LUM) ? DARK_INK : LIGHT_INK
}

/**
 * CSS 변수(테마별로 값이 바뀌는) 배경에 대한 읽기 좋은 전경색 — 테마 전환 시 재계산한다.
 * (applyTheme 가 window 'fl-theme' 이벤트를 쏜다.)
 */
export function useReadableInk(bg: string): string {
  const [ink, setInk] = useState(() => readableText(bg))
  useEffect(() => {
    const recompute = () => setInk(readableText(bg))
    recompute()
    window.addEventListener('fl-theme', recompute)
    return () => window.removeEventListener('fl-theme', recompute)
  }, [bg])
  return ink
}
