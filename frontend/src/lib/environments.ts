import { useSyncExternalStore } from 'react'

/**
 * 환경(dev/staging/prod) + 변수 — 실행 시 노드를 일일이 안 고치고 한 번에 전환.
 * 활성 환경의 변수는 실행 요청 env 로 전송돼 백엔드가 `{{ key@env }}` 로 해석한다.
 * 브라우저 localStorage 스코프(팀 공유 아님 — 개인/브라우저별). 클립보드·즐겨찾기와 같은 패턴.
 */
export interface EnvStore {
  active: string | null
  envs: Record<string, Record<string, string>>
}

const KEY = 'fl:environments'
let cache: EnvStore | null = null
const listeners = new Set<() => void>()

function read(): EnvStore {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) cache = JSON.parse(raw) as EnvStore
  } catch { /* 손상/프라이빗 무시 */ }
  if (!cache || typeof cache !== 'object' || !cache.envs) cache = { active: null, envs: {} }
  return cache
}

function write(next: EnvStore): void {
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 프라이빗 모드 */ }
  listeners.forEach((l) => l())
}

export function getEnvStore(): EnvStore { return read() }
export function setEnvStore(next: EnvStore): void { write(next) }

/** 활성 환경의 변수 맵(키가 빈 것은 제외). 없으면 {}. */
export function activeEnvVars(): Record<string, string> {
  const s = read()
  const vars = (s.active && s.envs[s.active]) || {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) if (k.trim()) out[k] = v
  return out
}

export function setActiveEnv(name: string | null): void {
  const s = read()
  write({ ...s, active: name && s.envs[name] ? name : null })
}

// React 구독 — 스위처/피커가 환경 변경에 즉시 반응
export function useEnvStore(): EnvStore {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    read,
  )
}
