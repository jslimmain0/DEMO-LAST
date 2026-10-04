import { useSyncExternalStore } from 'react'
import type { WorkspaceApi } from '../api/client'
import { useApi, useWorkspace } from '../app/WorkspaceContext'
import { toast } from '../components/toast'

/** 환경 데이터와 지연 저장은 워크스페이스에 묶인다. 공간 사이 자동 이관은 하지 않는다. */
export interface EnvStore {
  active: string | null
  envs: Record<string, Record<string, string>>
}

export function createEnvironment(api: WorkspaceApi, scopeKey: string) {
const { environmentsApi } = api
const ACTIVE_KEY = `fl:env:active:${scopeKey}`
let cache: EnvStore = { active: readActive(), envs: {} }
let serverSnapshot: Record<string, Record<string, string>> = {} // 마지막으로 서버와 일치한 상태(diff 기준)
let saveStatus: 'saved' | 'pending' | 'saving' | 'error' = 'saved'
let loadStatus: 'loading' | 'ready' | 'error' = 'loading'
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

/** 소유 워크스페이스에서 환경 목록을 읽는다. 실패 시 다음 호출에서 재시도한다. */
function ensureEnvLoaded(): Promise<void> {
  if (loaded) return loaded
  loadStatus = 'loading'; emit()
  loaded = (async () => {
    try {
      const list = await environmentsApi.list()
      const envs: Record<string, Record<string, string>> = {}
      for (const e of list) envs[e.name] = e.vars
      serverSnapshot = envs
      const active = cache.active && envs[cache.active] ? cache.active : null
      cache = { active, envs: structuredClone(envs) }
      loadStatus = 'ready'
      emit()
    } catch (e) {
      loadStatus = 'error'; emit()
      loaded = null // 다음 ensure 에서 재시도
      throw e
    }
  })()
  return loaded
}


/** 변경분을 서버에 반영(디바운스) — 추가/변경=PUT, 삭제=DELETE. 실패는 토스트 + 스냅샷 유지(다음 편집에서 재시도). */
function scheduleFlush(): void {
  saveStatus = 'pending'; emit()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushTimer = null; void flushEnvStore() }, 400)
}
let flushing: Promise<void> | null = null
async function flush(): Promise<void> {
  if (flushing) { await flushing; return }
  saveStatus = 'saving'; emit()
  flushing = (async () => {
    const want = structuredClone(cache.envs)
    const ops: Promise<unknown>[] = []
    for (const [name, vars] of Object.entries(want)) {
      if (!serverSnapshot[name] || !same(serverSnapshot[name], vars)) {
        ops.push(environmentsApi.put(name, vars).then(() => { serverSnapshot[name] = { ...vars } }))
      }
    }
    for (const name of Object.keys(serverSnapshot)) {
      if (!want[name]) ops.push(environmentsApi.remove(name).then(() => { delete serverSnapshot[name] }))
    }
    if (ops.length === 0) { saveStatus = 'saved'; return }
    const results = await Promise.allSettled(ops)
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    saveStatus = failed.length ? 'error' : hasUnstoredChanges() ? 'pending' : 'saved'
    if (failed.length) {
      const msg = (failed[0].reason as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast(`환경 저장 실패(${failed.length}건) — ${msg ?? '서버에 반영되지 않았습니다'}`, 'error')
    }
  })().finally(() => { flushing = null; emit() })
  await flushing
}

function hasUnstoredChanges(): boolean {
  return Object.entries(cache.envs).some(([name, vars]) => !serverSnapshot[name] || !same(serverSnapshot[name], vars)) || Object.keys(serverSnapshot).some(name => !cache.envs[name])
}

/** 호출 도중 들어온 변경까지 저장 완료를 기다린다. 실패 시 초안을 유지하고 재시도를 기다린다. */
async function flushEnvStore(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  do {
    await flush()
    if (saveStatus === 'error') return
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  } while (hasUnstoredChanges())
  saveStatus = 'saved'; emit()
}

async function prepareForRun(): Promise<void> {
  try { await ensureEnvLoaded() } catch { throw new Error('환경 변수를 불러오지 못했습니다. 연결을 확인한 후 다시 실행하세요.') }
  await flushEnvStore()
  if (saveStatus !== 'saved') throw new Error('환경 변수 변경을 저장하지 못했습니다. 환경 관리에서 다시 저장한 후 실행하세요.')
}

function getEnvStore(): EnvStore { return cache }

/** 전체 교체(EnvManager 편집 API 호환) — 환경/변수 변경은 서버 디바운스 저장, 활성은 브라우저 저장. */
function setEnvStore(next: EnvStore): void {
  if (loadStatus !== 'ready') { toast('환경 목록을 불러온 후 편집하세요.', 'error'); return }
  const active = next.active && next.envs[next.active] ? next.active : null
  if (active !== cache.active) persistActive(active)
  cache = { active, envs: next.envs }
  emit()
  scheduleFlush()
}

/** 이름 변경 — 변수 유지 + 서버 rename(원자적). */
async function renameEnv(from: string, to: string): Promise<void> {
  const t = to.trim()
  if (!t || t === from || !cache.envs[from]) return
  if (cache.envs[t]) { toast('같은 이름의 환경이 이미 있습니다.', 'error'); return }
  await flushEnvStore()
  if (saveStatus !== 'saved') return
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
function activeEnvVars(): Record<string, string> {
  const s = cache
  const vars = (s.active && s.envs[s.active]) || {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) if (k.trim()) out[k] = v
  return out
}

/** 활성 환경 이름 — 실행 요청 envName 으로 전송돼 시크릿 환경 스코프를 선택한다(없으면 공통만). */
function activeEnvName(): string | null {
  const s = cache
  return (s.active && s.envs[s.active]) ? s.active : null
}

function setActiveEnv(name: string | null): void {
  const active = name && cache.envs[name] ? name : null
  persistActive(active)
  cache = { ...cache, active }
  emit()
}


return { getLoadStatus: () => loadStatus, getSaveStatus: () => saveStatus, prepareForRun, ensureEnvLoaded, flushEnvStore, getEnvStore, setEnvStore, renameEnv, activeEnvVars, activeEnvName, setActiveEnv, subscribe: (cb: () => void) => { listeners.add(cb); void ensureEnvLoaded().catch(() => {}); return () => { listeners.delete(cb) } } }
}
const stores = new WeakMap<WorkspaceApi, ReturnType<typeof createEnvironment>>()
export function useEnvironment() {
 const api = useApi(); const { scopeKey } = useWorkspace()
 let store = stores.get(api)
 if (!store) { store = createEnvironment(api, scopeKey); stores.set(api, store) }
 return store
}
export function useEnvStore(): EnvStore { const store = useEnvironment(); return useSyncExternalStore(store.subscribe, store.getEnvStore) }

export function useEnvironmentSaveStatus() { const store = useEnvironment(); return useSyncExternalStore(store.subscribe, store.getSaveStatus) }

export function useEnvironmentLoadStatus() { const store = useEnvironment(); return useSyncExternalStore(store.subscribe, store.getLoadStatus) }
