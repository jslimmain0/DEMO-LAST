import { useSyncExternalStore } from 'react'
import type { WorkspaceApi } from '../api/client'
import { useApi } from '../app/WorkspaceContext'
import { toast } from '../components/toast'

/** 실행 입력 저장과 지연 쓰기는 소유 워크스페이스에 고정한다. */
function createRunInput(api: WorkspaceApi) {
const { runInputApi } = api
let flowId: string | null = null
let vars: Record<string, string> = {}
let saved: Record<string, string> = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function notify(): void { listeners.forEach((l) => l()) }

/** 에디터가 플로우를 로드할 때 호출 — 그 플로우의 저장된 입력을 현재 싱글턴에 올린다. */
function loadRunInput(id: string): void {
  if (flowId !== id && flushTimer) {
    clearTimeout(flushTimer); flushTimer = null
    void flush()
  }
  flowId = id
  vars = {}; saved = {}
  notify()
  void (async () => {
    try {
      const r = await runInputApi.get(id)
      if (flowId !== id) return // 그 사이 다른 플로우로 전환
      const next = r.vars ?? {}
      if (flowId !== id) return
      vars = next; saved = { ...next }
      notify()
    } catch { /* 읽기 실패 — 빈 입력으로 시작(실행은 여전히 가능) */ }
  })()
}

function setRunInputVars(next: Record<string, string>): void {
  vars = next
  notify()
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => { flushTimer = null; void flush() }, 400)
}

async function flush(): Promise<void> {
  const id = flowId
  if (!id) return
  const snapshot = { ...vars }
  if (JSON.stringify(snapshot) === JSON.stringify(saved)) return
  try {
    await runInputApi.put(id, snapshot)
    if (flowId === id) saved = snapshot
  } catch (e) {
    toast(`실행 입력값 저장 실패 — ${(e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '서버에 반영되지 않았습니다'}`, 'error')
  }
}

/** 서버 반영을 기다린다(테스트/즉시 확인용). */
async function flushRunInput(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await flush()
}

/** 실행 요청에 실을 입력 맵(빈 키 제외). 값 없으면 {}. */
function activeInputVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) if (k.trim()) out[k] = v
  return out
}

function getRunInputVars(): Record<string, string> { return vars }


return { loadRunInput, setRunInputVars, flushRunInput, activeInputVars, getRunInputVars, subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } } }
}
const stores = new WeakMap<WorkspaceApi, ReturnType<typeof createRunInput>>()
export function useRunInputActions() { const api = useApi(); let store = stores.get(api); if (!store) { store = createRunInput(api); stores.set(api, store) } return store }
export function useRunInput() { const store = useRunInputActions(); return useSyncExternalStore(store.subscribe, store.getRunInputVars) }
