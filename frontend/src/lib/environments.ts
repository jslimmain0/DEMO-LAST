import { useSyncExternalStore } from 'react'
import { environmentsApi } from '../api/client'
import { toast } from '../components/toast'

/**
 * 환경(dev/staging/prod) + 변수 — 실행 시 노드를 일일이 안 고치고 한 번에 전환.
 * 활성 환경의 변수는 실행 요청 env 로 전송돼 백엔드가 `{{ key@env }}` 로 해석한다.
 *
 * 저장소: **환경·변수는 서버 DB(테넌트 스코프 — 팀 공유, 브라우저 무관)**, 활성 환경 선택만 브라우저(개인 취향).
 * 모듈 싱글턴 store 를 유지해 `useEnvStore()`/`activeEnvVars()` 소비자는 그대로 — 저장 계층만 API 로.
 * 편집은 400ms 디바운스로 변경분(PUT/DELETE)만 서버에 반영. 구 localStorage(`fl:environments`) 데이터는 서버가 비어 있을 때 1회 이관.
 */
export interface EnvStore {
  active: string | null
  envs: Record<string, Record<string, string>>
}

const LEGACY_KEY = 'fl:environments'
const ACTIVE_KEY = 'fl:env:active'
let cache: EnvStore = { active: readActive(), envs: {} }
let serverSnapshot: Record<string, Record<string, string>> = {} // 마지막으로 서버와 일치한 상태(diff 기준)
let loaded: Promise<void> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function readActive(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY) } catch { return null }
}
function persistActive(name: string | null): void {
  try { if (name) localStorage.setItem(ACTIVE_KEY, name); else localStorage.removeItem(ACTIVE_KEY) } catch { /* 프라이빗 */ }
}
function emit(): void { listeners.forEach((l) => l()) }
const same = (a: Record<string, string>, b: Record<string, string>): boolean => JSON.stringify(a) === JSON.stringify(b)

/** 서버에서 환경 목록 로드(1회, 실패 시 다음 호출에서 재시도). 구 localStorage 데이터는 서버가 비어 있으면 이관. */
export function ensureEnvLoaded(): Promise<void> {
  if (loaded) return loaded
  loaded = (async () => {
    try {
      const list = await environmentsApi.list()
      const envs: Record<string, Record<string, string>> = {}
      for (const e of list) envs[e.name] = e.vars
      // 1회 이관 — 서버가 비어 있고 브라우저에 구 환경이 있으면 올린다(팀 공유로 승격)
      if (list.length === 0) {
        const legacy = readLegacy()
        if (legacy && Object.keys(legacy.envs).length > 0) {
          let n = 0
          for (const [name, vars] of Object.entries(legacy.envs)) {
            try { await environmentsApi.put(name, vars); envs[name] = vars; n++ } catch { /* 권한 없음(게스트) 등 — 건너뜀 */ }
          }
          if (n > 0) {
            toast(`브라우저에 있던 환경 ${n}개를 서버로 옮겼습니다 — 이제 팀과 공유됩니다.`, 'ok')
            if (!cache.active && legacy.active && envs[legacy.active]) { cache = { ...cache, active: legacy.active }; persistActive(legacy.active) }
            try { localStorage.removeItem(LEGACY_KEY) } catch { /* */ }
          }
        }
      }
      serverSnapshot = envs
      const active = cache.active && envs[cache.active] ? cache.active : null
      cache = { active, envs: structuredClone(envs) }
      emit()
    } catch (e) {
      loaded = null // 다음 ensure 에서 재시도
      throw e
    }
  })()
  return loaded
}

function readLegacy(): EnvStore | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as EnvStore
    return p && typeof p === 'object' && p.envs ? p : null
  } catch { return null }
}

/** 변경분을 서버에 반영(디바운스) — 추가/변경=PUT, 삭제=DELETE. 실패는 토스트 + 스냅샷 유지(다음 편집에서 재시도). */
function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushTimer = null; void flush() }, 400)
}
let flushing: Promise<void> | null = null
async function flush(): Promise<void> {
  if (flushing) { await flushing; scheduleFlush(); return }
  flushing = (async () => {
    const want = cache.envs
    const ops: Promise<unknown>[] = []
    for (const [name, vars] of Object.entries(want)) {
      if (!serverSnapshot[name] || !same(serverSnapshot[name], vars)) {
        ops.push(environmentsApi.put(name, vars).then(() => { serverSnapshot[name] = { ...vars } }))
      }
    }
    for (const name of Object.keys(serverSnapshot)) {
      if (!want[name]) ops.push(environmentsApi.remove(name).then(() => { delete serverSnapshot[name] }))
    }
    if (ops.length === 0) return
    const results = await Promise.allSettled(ops)
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    if (failed.length) {
      const msg = (failed[0].reason as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast(`환경 저장 실패(${failed.length}건) — ${msg ?? '서버에 반영되지 않았습니다'}`, 'error')
    }
  })().finally(() => { flushing = null })
  await flushing
}

/** 서버 반영을 기다린다(테스트/즉시 확인용). */
export async function flushEnvStore(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await flush()
}

export function getEnvStore(): EnvStore { return cache }

/** 전체 교체(EnvManager 편집 API 호환) — 환경/변수 변경은 서버 디바운스 저장, 활성은 브라우저 저장. */
export function setEnvStore(next: EnvStore): void {
  const active = next.active && next.envs[next.active] ? next.active : null
  if (active !== cache.active) persistActive(active)
  cache = { active, envs: next.envs }
  emit()
  scheduleFlush()
}

/** 이름 변경 — 변수 유지 + 서버 rename(원자적). */
export async function renameEnv(from: string, to: string): Promise<void> {
  const t = to.trim()
  if (!t || t === from || !cache.envs[from]) return
  if (cache.envs[t]) { toast('같은 이름의 환경이 이미 있습니다.', 'error'); return }
  await flushEnvStore()
  try {
    await environmentsApi.rename(from, t)
    const vars = serverSnapshot[from] ?? cache.envs[from]
    delete serverSnapshot[from]; serverSnapshot[t] = { ...vars }
  } catch (e) {
    toast(`이름 변경 실패 — ${(e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '서버 오류'}`, 'error')
    return
  }
  const envs: Record<string, Record<string, string>> = {}
  for (const [k, v] of Object.entries(cache.envs)) envs[k === from ? t : k] = v
  const active = cache.active === from ? t : cache.active
  if (active !== cache.active) persistActive(active)
  cache = { active, envs }
  emit()
}

/** 활성 환경의 변수 맵(키가 빈 것은 제외). 없으면 {}. */
export function activeEnvVars(): Record<string, string> {
  const s = cache
  const vars = (s.active && s.envs[s.active]) || {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) if (k.trim()) out[k] = v
  return out
}

/** 활성 환경 이름 — 실행 요청 envName 으로 전송돼 시크릿 환경 스코프를 선택한다(없으면 공통만). */
export function activeEnvName(): string | null {
  const s = cache
  return (s.active && s.envs[s.active]) ? s.active : null
}

export function setActiveEnv(name: string | null): void {
  const active = name && cache.envs[name] ? name : null
  persistActive(active)
  cache = { ...cache, active }
  emit()
}

// React 구독 — 스위처/피커가 환경 변경에 즉시 반응. 첫 구독 시 서버 로드.
export function useEnvStore(): EnvStore {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); void ensureEnvLoaded().catch(() => {}); return () => listeners.delete(cb) },
    () => cache,
  )
}
