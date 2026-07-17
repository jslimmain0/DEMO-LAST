import { useSyncExternalStore } from 'react'

/**
 * 실행 입력(런타임 파라미터) — 플로우별로 `{{ 키@input }}` 로 참조되는 입력값.
 * 환경(env)이 dev/staging/prod 공통 변수라면, 입력은 "이번 실행에 넣는 값"(파라미터화 실행).
 * 에디터에서 현재 플로우 하나만 열리므로 모듈 싱글턴으로 현재 플로우 입력을 들고 있고,
 * 플로우가 바뀌면 loadRunInput(flowId) 로 localStorage(`fl:runinput:<flowId>`)에서 다시 읽는다.
 */
let flowId: string | null = null
let vars: Record<string, string> = {}
const listeners = new Set<() => void>()

function keyFor(id: string): string { return `fl:runinput:${id}` }
function notify(): void { listeners.forEach((l) => l()) }

/** 에디터가 플로우를 로드할 때 호출 — 그 플로우의 저장된 입력을 현재 싱글턴에 올린다. */
export function loadRunInput(id: string): void {
  flowId = id
  vars = {}
  try {
    const raw = localStorage.getItem(keyFor(id))
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') vars = parsed as Record<string, string>
    }
  } catch { /* 손상/프라이빗 무시 */ }
  notify()
}

export function setRunInputVars(next: Record<string, string>): void {
  vars = next
  if (flowId) { try { localStorage.setItem(keyFor(flowId), JSON.stringify(next)) } catch { /* 프라이빗 */ } }
  notify()
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
