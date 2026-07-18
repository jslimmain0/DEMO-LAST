import type { FlowGraph } from '../api/types'

/**
 * 캔버스에 로드하기 전 그래프 JSON 형태 검증(수동 가져오기·AI 어시스턴트 공용).
 * React Flow 키가 깨지지 않도록 nodes 배열·문자열 id·중복 없음·edges 배열을 확인.
 * @returns 오류 메시지(있으면) 또는 null(유효).
 */
export function validateGraphShape(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return '워크플로 JSON(객체)이 아닙니다.'
  const g = parsed as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(g.nodes)) return 'nodes 배열이 있는 워크플로 JSON 이 아닙니다.'
  if (g.edges != null && !Array.isArray(g.edges)) return 'edges 는 배열이어야 합니다.'
  const ids = new Set<string>()
  for (const n of g.nodes) {
    const id = (n as { id?: unknown })?.id
    if (typeof id !== 'string' || !id) return '각 노드에 문자열 id 가 필요합니다.'
    if (ids.has(id)) return `노드 id 가 중복됩니다: ${id}`
    ids.add(id)
  }
  return null
}

/** START 노드가 있는지 — 실행 가능성(크래시 안전과 별개, 소프트 경고용). */
export function hasStartNode(g: FlowGraph): boolean {
  return (g.nodes ?? []).some((n) => n.type === 'start')
}

/** validateGraphShape 통과 여부(부울). */
export function isValidGraphShape(g: unknown): g is FlowGraph {
  return validateGraphShape(g) === null
}
