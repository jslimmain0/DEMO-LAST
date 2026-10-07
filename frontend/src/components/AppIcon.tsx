import type { CSSProperties, ReactNode } from 'react'

const paths = {
  flow: <><path d="m10.5 6.7-5 9.2m13 0-5-9.2M7 19h10"/><circle cx="12" cy="4.5" r="2.5"/><circle cx="4.5" cy="19" r="2.5"/><circle cx="19.5" cy="19" r="2.5"/></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>,
  workspace: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
  server: <><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  key: <><circle cx="8" cy="8" r="5"/><path d="m11.5 11.5 9 9m-3-3 3-3m-6 0 3-3"/></>,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
  shield: <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6"/>,
  settings: <><path d="m10 2-.6 2.6-2.1 1.2-2.6-.8-2 3.5 2 1.8v2.4l-2 1.8 2 3.5 2.6-.8 2.1 1.2.6 2.6h4l.6-2.6 2.1-1.2 2.6.8 2-3.5-2-1.8v-2.4l2-1.8-2-3.5-2.6.8-2.1-1.2L14 2Z"/><circle cx="12" cy="12" r="3.2"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  arrowLeft: <path d="m10 5-7 7 7 7M3 12h18"/>,
  arrowRight: <path d="m14 5 7 7-7 7M3 12h18"/>,
  chevronDown: <path d="m6 9 6 6 6-6"/>,
  chevronRight: <path d="m9 6 6 6-6 6"/>,
  chevronLeft: <path d="m15 6-6 6 6 6"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  moreVertical: <><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></>,
  diamond: <path d="m12 3 9 9-9 9-9-9Z"/>,
  arrows: <path d="M3 7h17m-5-4 5 4-5 4M21 17H4m5-4-5 4 5 4"/>,
  file: <><path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6"/></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/></>,
  pencil: <path d="m15 3 6 6M3 21l2-7L16 3l5 5L10 19Z"/>,
  play: <path d="m8 4 12 8-12 8Z"/>,
  pause: <path d="M8 5v14M16 5v14"/>,
  stop: <rect x="5" y="5" width="14" height="14" rx="2"/>,
  save: <><path d="M5 3h12l4 4v14H3V3Zm2 0v6h10V3M7 21v-7h10v7"/></>,
  undo: <path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"/>,
  redo: <path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14"/>,
  upload: <path d="M4 16v5h16v-5M12 16V3m-5 5 5-5 5 5"/>,
  download: <path d="M4 16v5h16v-5M12 3v13m-5-5 5 5 5-5"/>,
  sliders: <><path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></>,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
  panelLeft: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  panelRight: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
  grid: <><path d="M3 8h18M3 16h18M8 3v18M16 3v18"/></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>,
  check: <path d="m4 12 5 5L20 6"/>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
  trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  moon: <path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>,
  sparkles: <><path d="m10 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2Zm9 12 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/></>,
  external: <path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  logout: <path d="M10 3H3v18h7m-1-9h12m-4-4 4 4-4 4"/>,
  refresh: <path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>,
  filter: <path d="M3 4h18l-7 8v7l-4 2v-9Z"/>,
  branch: <><path d="M6 6v12m0-6h6a6 6 0 0 0 6-6"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/></>,
  link: <><path d="m9 15 6-6m-7 4-2 2a4 4 0 0 0 6 6l3-3m-6-6 3-3a4 4 0 0 1 6 6l-2 2"/></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-8Z"/>,
  alert: <><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/></>,
} satisfies Record<string, ReactNode>

export type AppIconName = keyof typeof paths
export function AppIcon({ name, size = 18, className, style }: { name: AppIconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} style={{ flexShrink: 0, verticalAlign: 'middle', ...style }}>{paths[name]}</svg>
}

/** 팔레트·캔버스·속성 패널에서 같은 노드 종류를 같은 모양으로 표시한다. */
export function NodeTypeIcon({ type, size = 30 }: { type: string; size?: number }) {
  const icon: AppIconName = type === 'start' ? 'play' : type === 'end' ? 'stop' : type === 'tcp' ? 'arrows'
    : type === 'if' ? 'diamond' : type === 'assert' ? 'check' : type === 'set' ? 'code'
    : type === 'wait' ? 'clock' : type === 'form' ? 'file' : type === 'input' ? 'keyboard'
    : type === 'transform' ? 'settings' : type === 'switch' ? 'branch' : type === 'note' ? 'pencil'
    : type === 'group' ? 'workspace' : 'link'
  return <span className="fl-type-tile" data-node-type={type} aria-hidden="true" style={{ width: size, height: size }}>
    {type === 'http' ? <span className="fl-type-http">HTTP</span> : <AppIcon name={icon} size={Math.round(size * .6)} />}
  </span>
}
