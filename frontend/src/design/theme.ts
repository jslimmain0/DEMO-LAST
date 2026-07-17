export type Theme = 'light' | 'dark'
const KEY = 'flowlink-theme'

export function getTheme(): Theme {
  const saved = localStorage.getItem(KEY)
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem(KEY, theme)
  // 테마별 CSS 변수 배경 위 글자색(useReadableInk)이 재계산되도록 알림
  window.dispatchEvent(new CustomEvent('fl-theme', { detail: theme }))
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}
