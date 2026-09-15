import type { MockCodecSpec, MockCodecStep, MockCodecTarget, MockRuleSpec, TransformInfo } from '../api/types'

/**
 * 코덱 편집 도우미(순수) — "필드에서 시작" UX 의 핵심: 필드 하나에 걸린 단계 찾기/추가/제거, 단계 한 줄 요약.
 * 단계는 spec.codec(서버) 또는 route.codec(라우트) 어느 쪽에나 있을 수 있어 호출자가 대상 코덱 객체를 넘긴다.
 */
export type CodecSide = 'request' | 'response'

export interface StepRef { side: CodecSide; index: number; step: MockCodecStep }

/** 이 필드를 대상으로 하는 단계들(target=fields 에 필드 포함). */
export function stepsForField(codec: MockCodecSpec | null | undefined, field: string): StepRef[] {
  const out: StepRef[] = []
  for (const side of ['request', 'response'] as const) {
    ;(codec?.[side] ?? []).forEach((step, index) => { if ((step.target ?? 'body') === 'fields' && (step.fields ?? []).includes(field)) out.push({ side, index, step }) })
  }
  return out
}

/** 단계 추가(해당 side 끝에). */
export function addStep(codec: MockCodecSpec | null | undefined, side: CodecSide, step: MockCodecStep): MockCodecSpec {
  return { ...(codec ?? {}), [side]: [...(codec?.[side] ?? []), step] }
}

/** 단계 교체. */
export function replaceStep(codec: MockCodecSpec | null | undefined, side: CodecSide, index: number, step: MockCodecStep): MockCodecSpec {
  return { ...(codec ?? {}), [side]: (codec?.[side] ?? []).map((s, i) => (i === index ? step : s)) }
}

/** 단계 제거 — 비면 null(코덱 없음). */
export function removeStep(codec: MockCodecSpec | null | undefined, side: CodecSide, index: number): MockCodecSpec | null {
  const next: MockCodecSpec = { ...(codec ?? {}), [side]: (codec?.[side] ?? []).filter((_, i) => i !== index) }
  if (!next.request?.length) delete next.request
  if (!next.response?.length) delete next.response
  return next.request?.length || next.response?.length ? next : null
}

/** 필드 하나를 단계의 fields 에서 빼기(마지막 필드면 단계 자체 제거). */
export function detachField(codec: MockCodecSpec | null | undefined, ref: StepRef, field: string): MockCodecSpec | null {
  const rest = (ref.step.fields ?? []).filter((f) => f !== field)
  if (rest.length === 0) return removeStep(codec, ref.side, ref.index)
  return replaceStep(codec, ref.side, ref.index, { ...ref.step, fields: rest })
}

export function stepCount(codec: MockCodecSpec | null | undefined): { request: number; response: number } {
  return { request: codec?.request?.length ?? 0, response: codec?.response?.length ?? 0 }
}

export const sideLabel = (side: CodecSide): string => (side === 'request' ? '요청 전' : '응답 후')
export const targetLabel = (t: MockCodecTarget | undefined): string =>
  t === 'fields' ? '필드' : t === 'header' ? '헤더' : '본문 전체'

/** 단계 한 줄 요약 — "응답 후 · user.name, pin 필드 → Base64 인코딩 (key: 시크릿)". */
export function summarizeStep(step: MockCodecStep, side: CodecSide, plugins: TransformInfo[]): string {
  const t = plugins.find((p) => p.id === step.id)
  const name = t?.label ?? step.id ?? '(플러그인 미선택)'
  const target = step.target ?? 'body'
  const what = target === 'fields' ? `${(step.fields ?? []).join(', ') || '(필드 없음)'} 필드` : target === 'header' ? `헤더 ${step.header || '(이름 없음)'}` : targetLabel('body')
  const vals = (step.inputs ?? []).filter((i) => i.mode === 'value' && i.value).map((i) => `${i.key}: ${short(i.value!)}`)
  const cfg = (step.config ?? []).filter((c) => c.value).map((c) => `${c.key}: ${short(c.value)}`)
  const extra = [...vals, ...cfg]
  return `${sideLabel(side)} · ${what} → ${name}${extra.length ? ` (${extra.join(' · ')})` : ''}`
}

function short(v: string): string {
  const m = /^\{\{\s*([^@}]+)@(\w+)\s*\}\}$/.exec(v.trim())
  if (m) return m[2] === 'secret' ? `🔑 ${m[1]}` : `${m[1]}@${m[2]}`
  return v.length > 18 ? v.slice(0, 16) + '…' : v
}

/** 응답 본문 템플릿(JSON)에서 키 경로 추출 — 토큰은 값으로 치환해 파싱, 깊이 3·최대 40개. 코덱 "필드에서 시작" 응답측 후보. */
export function responseBodyKeys(rule: MockRuleSpec): string[] {
  const body = (rule.body ?? '').trim()
  if (!body.startsWith('{')) return []
  let parsed: unknown
  try { parsed = JSON.parse(body.replace(/\{\{[^}]*\}\}/g, 'x')) } catch { return [] }
  const out: string[] = []
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (out.length >= 40 || v == null || typeof v !== 'object') return
    if (Array.isArray(v)) { if (v.length && depth < 3) walk(v[0], `${prefix}[0]`, depth + 1); return }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k
      if (val != null && typeof val === 'object' && depth < 3) walk(val, p, depth + 1)
      else out.push(p)
    }
  }
  walk(parsed, '', 0)
  return out
}
