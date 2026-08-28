// 데이터 삽입 피커의 '최근 사용' — 최근 삽입한 바인딩을 localStorage 에 보관해 상단에 노출.
// 노드가 많아 칩이 수십 개일 때 매번 스크롤/검색하지 않게 하는 장치. 브라우저 개인 스코프.
import type { Binding } from '../api/types'

const KEY = 'fl:bind:recent'
const MAX = 8

export interface RecentBinding {
  sourceId: string
  key: string
  scope: 'req' | null
}

export function getRecentBindings(): RecentBinding[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((r): r is RecentBinding => !!r && typeof r === 'object' && typeof (r as RecentBinding).sourceId === 'string' && typeof (r as RecentBinding).key === 'string')
      .slice(0, MAX)
  } catch {
    return []
  }
}

/** 방금 삽입한 바인딩을 맨 앞에 기록(동일 항목은 앞으로 끌어올림, 최대 8개). */
export function pushRecentBinding(b: Binding) {
  try {
    const item: RecentBinding = { sourceId: b.sourceId, key: b.key, scope: b.scope ?? null }
    const rest = getRecentBindings().filter((r) => !(r.sourceId === item.sourceId && r.key === item.key && (r.scope ?? null) === (item.scope ?? null)))
    localStorage.setItem(KEY, JSON.stringify([item, ...rest].slice(0, MAX)))
  } catch { /* 저장 불가 환경(사파리 프라이빗 등)은 조용히 무시 */ }
}
