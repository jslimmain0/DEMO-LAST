// 공용 인라인 SVG 아이콘 — currentColor 상속(버튼 색 따라감), 접근성은 버튼 title/aria-label 로.

/** 데이터 삽입(바인딩 토큰) — 코드 중괄호 { } 아이콘. */
export function DataInsertIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
      <path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
    </svg>
  )
}

/** 서버(랙) — Mock 서버 현황 타일. 두 칸 랙 + 상태등 자리(색은 currentColor). */
export function ServerIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <rect x="3" y="3" width="18" height="7" rx="1.5" />
      <rect x="3" y="14" width="18" height="7" rx="1.5" />
      <circle cx="7" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
      <path d="M11 6.5h6M11 17.5h6" strokeWidth="1.4" opacity=".6" />
    </svg>
  )
}

/** 복사. */
export function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: 'block' }}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
