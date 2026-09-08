import { useSyncExternalStore } from 'react'
import { runInputApi } from '../api/client'
import { toast } from '../components/toast'

/**
 * 실행 입력(런타임 파라미터) — 플로우별로 `{{ 키@input }}` 로 참조되는 입력값.
 * 환경(env)이 dev/staging/prod 공통 변수라면, 입력은 "이번 실행에 넣는 값"(파라미터화 실행).
 * 에디터에서 현재 플로우 하나만 열리므로 모듈 싱글턴으로 현재 플로우 입력을 들고 있고,
 * 플로우가 바뀌면 loadRunInput(flowId) 가 **서버**(`GET /flows/{id}/run-input`, 플로우별 DB 저장 — 팀 공유)에서 읽는다.
 * 구 localStorage(`fl:runinput:<flowId>`)는 서버가 비어 있으면 1회 이관.
 */
let flowId: string | null = null
let vars: Record<string, string> = {}
let saved: Record<string, string> = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function legacyKey(id: string): string { return `fl:runinput:${id}` }
function notify(): void { listeners.forEach((l) => l()) }

/** 에디터가 플로우를 로드할 때 호출 — 그 플로우의 저장된 입력을 현재 싱글턴에 올린다. */
export function loadRunInput(id: string): void {
  flowId = id
  vars = {}; saved = {}
  notify()
  void (async () => {
    try {
      const r = await runInputApi.get(id)
      if (flowId !== id) return // 그 사이 다른 플로우로 전환
      let next = r.vars ?? {}
      if (Object.keys(next).length === 0) {
        // 1회 이관 — 서버가 비어 있고 브라우저에 구 값이 있으면 올린다
        try {
          const raw = localStorage.getItem(legacyKey(id))
          const parsed = raw ? JSON.parse(raw) : null
          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            await runInputApi.put(id, parsed as Record<string, string>)
            next = parsed as Record<string, string>
            localStorage.removeItem(legacyKey(id))
          }
        } catch { /* 권한 없음/손상 — 무시 */ }
      }
      if (flowId !== id) return
      vars = next; saved = { ...next }
      notify()
    } catch { /* 읽기 실패 — 빈 입력으로 시작(실행은 여전히 가능) */ }
  })()
}

export function setRunInputVars(next: Record<string, string>): void {
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
export async function flushRunInput(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  await flush()
}

/** 실행 요청에 실을 입력 맵(빈 키 제외). 값 없으면 {}. */
export function activeInputVars(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(vars)) if (k.trim()) out[k] = v
  return out
}

export function getRunInputVars(): Record<string, string> { return vars }

export function useRunInput(): Record<string, string> {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => vars,
  )
}
