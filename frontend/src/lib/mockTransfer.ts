import type { MockKind, MockServerSpec } from '../api/types'
import { validateMockSpecShape } from './mockSpecValidate'

/**
 * Mock 서버 한 개의 export/import 텍스트 포맷(복사·붙여넣기).
 * `{ kind:"flowlink-mock", version:1, name, slug, type, spec }` — spec 은 편집기가 저장하는 그대로(라우트·TCP·코덱 포함).
 * 워크스페이스 번들(`flowlink-workspace`)과는 별개의 단일 mock 포맷.
 */
export const MOCK_BUNDLE_KIND = 'flowlink-mock'

export interface MockBundle {
  kind: typeof MOCK_BUNDLE_KIND
  version: 1
  name: string
  slug: string
  type: 'HTTP' | 'TCP'
  spec: MockServerSpec
}

export function toMockBundle(m: { name: string; slug: string; kind: MockKind; spec: MockServerSpec | null | undefined }): MockBundle {
  // CUSTOM(레거시)은 tcp 섹션 유무로 유형 결정
  const type: 'HTTP' | 'TCP' = m.kind === 'TCP' || (m.kind === 'CUSTOM' && !!m.spec?.tcp && !(m.spec?.routes?.length)) ? 'TCP' : 'HTTP'
  return { kind: MOCK_BUNDLE_KIND, version: 1, name: m.name, slug: m.slug, type, spec: m.spec ?? { routes: [] } }
}

export function serializeMockBundle(b: MockBundle): string {
  return JSON.stringify(b, null, 2)
}

export type ParsedMockBundle = { ok: true; bundle: MockBundle } | { ok: false; error: string }

/** 붙여넣은 텍스트 → 번들. 형태만 검증(의미는 저장 시 백엔드 parseSpec 이 확인). */
export function parseMockBundle(text: string): ParsedMockBundle {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, error: 'JSON 파싱 실패 — 내보내기 텍스트를 그대로 붙여넣으세요.' } }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '객체 JSON 이 아닙니다.' }
  const o = raw as Record<string, unknown>
  if (o.kind !== MOCK_BUNDLE_KIND) {
    if (o.kind === 'flowlink-workspace') return { ok: false, error: '워크스페이스 번들입니다 — 워크스페이스 관리의 [가져오기]를 쓰세요.' }
    return { ok: false, error: `kind 가 "${MOCK_BUNDLE_KIND}" 이 아닙니다.` }
  }
  if (o.version !== 1) return { ok: false, error: `지원하지 않는 version: ${String(o.version)}` }
  const specErr = validateMockSpecShape(o.spec)
  if (specErr) return { ok: false, error: `spec: ${specErr}` }
  const spec = o.spec as MockServerSpec
  const type: 'HTTP' | 'TCP' = o.type === 'TCP' ? 'TCP' : 'HTTP'
  const name = typeof o.name === 'string' ? o.name : ''
  const slug = typeof o.slug === 'string' ? o.slug : ''
  return { ok: true, bundle: { kind: MOCK_BUNDLE_KIND, version: 1, name, slug, type, spec } }
}

/** slug 형식(생성 폼과 동일 규칙). */
export const isValidSlug = (s: string): boolean => /^[a-z0-9-]{3,40}$/.test(s)

/** 충돌 시 -2, -3 … 접미사 후보(40자 제한 안에서). */
export function nextSlugCandidate(slug: string, n: number): string {
  const base = slug.replace(/-\d+$/, '')
  const suffix = `-${n}`
  return (base.slice(0, 40 - suffix.length) + suffix)
}

/**
 * 붙여넣은 spec 을 현재 mock 에 덮어쓸 때 — 포트는 전역 자원이라 TCP 는 경고만 남긴다(리스너 on/off 는 Mock 의 켜짐 상태).
 * @returns 적용할 spec + 경고
 */
export function prepareImportedSpec(spec: MockServerSpec, opts: { disableTcp: boolean }): { spec: MockServerSpec; warnings: string[] } {
  const warnings: string[] = []
  const out: MockServerSpec = { ...spec }
  if (opts.disableTcp && out.tcp) {
    warnings.push(`TCP 포트 ${out.tcp.port ?? '?'} 로 가져왔습니다 — 다른 Mock 과 충돌하면 저장이 거절됩니다(연결에서 포트를 바꾸세요).`)
  }
  return { spec: out, warnings }
}
