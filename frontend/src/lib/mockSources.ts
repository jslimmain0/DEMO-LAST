import type { SecretView } from '../api/client'
import type { MockRouteSpec, MockServerSpec } from '../api/types'
import type { BindableItem, BindableSource } from '../binding/upstream'

/**
 * Mock 편집기의 데이터 삽입 피커 소스 — 워크플로의 "상위 노드" 대신 **이 Mock 이 받을 것**(예상 요청·서버 상태·시크릿·TCP 요청 레이아웃).
 * 어떤 요청이 올지 모르니 라우트의 예상 요청(expect)에 미리 정의한 키(요청 기록에서 자동 채움)를 소스로 쓴다.
 * 토큰은 워크플로 문법 `{{ 키@소스 }}` 로 직렬화되며 백엔드 MockTemplate 이 `{{body.x}}` 와 동일하게 해석한다.
 */
export interface MockSourceOpts {
  spec: MockServerSpec
  route?: MockRouteSpec | null
  secrets?: SecretView[]
  /** 이 Mock 의 시크릿 환경(spec.environment). 공통(+Vault) + 이 환경의 시크릿이 적용 대상. */
  environment?: string | null
  /** TCP 편집기에서 true — 요청 레이아웃 필드를 소스로. */
  tcp?: boolean
}

const item = (key: string, tag: string, type?: string): BindableItem => ({ key, type, scope: null, group: 'request', tag })

/** 경로 패턴(/users/{id}/orders/{no})의 파라미터 이름. */
export function pathParamNames(path: string | undefined | null): string[] {
  const out: string[] = []
  for (const m of (path ?? '').matchAll(/\{([^}/]+)\}/g)) out.push(m[1])
  return out
}

/** spec 전체 규칙의 setState 키 합집합 — {{ 키@state }} 후보. */
export function stateKeys(spec: MockServerSpec): string[] {
  const keys = new Set<string>()
  for (const r of spec.routes ?? []) for (const u of r.rules ?? []) for (const s of u.setState ?? []) if (s.key?.trim()) keys.add(s.key.trim())
  return [...keys]
}

/** 이 Mock 에 적용되는 시크릿 이름(공통 + 환경 오버레이 + Vault). 같은 이름은 한 번. */
export function applicableSecretNames(secrets: SecretView[] | undefined, environment: string | null | undefined): string[] {
  const env = environment?.trim() || null
  const names = new Set<string>()
  for (const s of secrets ?? []) {
    if (!s.environment || s.environment === env || s.source === 'vault') names.add(s.name)
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

export function mockSources(o: MockSourceOpts): BindableSource[] {
  const out: BindableSource[] = []
  const r = o.route
  if (!o.tcp) {
    const pathParams = pathParamNames(r?.path)
    if (pathParams.length) out.push({ id: 'path', name: '경로 파라미터', type: 'mock', cat: 'http', items: pathParams.map((k) => item(k, '경로')) })
    const q = (r?.expect?.query ?? []).filter((f) => f.key?.trim())
    if (q.length) out.push({ id: 'query', name: '쿼리', type: 'mock', cat: 'http', items: q.map((f) => item(f.key.trim(), '쿼리', f.type)) })
    const h = (r?.expect?.header ?? []).filter((f) => f.key?.trim())
    if (h.length) out.push({ id: 'header', name: '요청 헤더', type: 'mock', cat: 'http', items: h.map((f) => item(f.key.trim(), '헤더', f.type)) })
    const b = (r?.expect?.body ?? []).filter((f) => f.key?.trim())
    if (b.length) out.push({ id: 'body', name: '요청 본문', type: 'mock', cat: 'http', items: b.map((f) => item(f.key.trim(), '본문', f.type)) })
  } else {
    const fields = (o.spec.tcp?.requestFields ?? []).map((f) => f.name?.trim() ?? '').filter(Boolean)
    if (fields.length) out.push({ id: 'req', name: 'TCP 요청 필드', type: 'mock', cat: 'tcp', items: fields.map((k) => item(k, '요청')) })
  }
  const st = stateKeys(o.spec)
  if (st.length) out.push({ id: 'state', name: '서버 상태', type: 'mock', cat: 'set', items: st.map((k) => item(k, '상태')) })
  const sec = applicableSecretNames(o.secrets, o.environment)
  if (sec.length) out.push({ id: 'secret', name: '시크릿 볼트', type: 'mock', cat: 'secret', items: sec.map((k) => item(k, '시크릿')) })
  return out
}

/**
 * 큰 편집기 미리보기용 샘플 값 — 예상 요청 예시값(`orderId@body`)·경로 파라미터(`id@path`='1')·본문 전체(`body` = 예시 JSON).
 * templatePreview 의 샘플 맵 규약(`key@source`)과 일치.
 */
export function sampleValuesFor(route: MockRouteSpec | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!route) return out
  for (const p of pathParamNames(route.path)) out[`${p}@path`] = '1'
  const bodyObj: Record<string, string> = {}
  for (const [src, rows] of [['body', route.expect?.body], ['query', route.expect?.query], ['header', route.expect?.header]] as const) {
    for (const f of rows ?? []) {
      const k = f.key?.trim()
      if (!k) continue
      out[`${k}@${src}`] = f.example ?? ''
      if (src === 'body') bodyObj[k] = f.example ?? ''
    }
  }
  if (Object.keys(bodyObj).length) out.body = JSON.stringify(bodyObj)
  return out
}

/** 예상 요청(expect)에서 조건/코덱 필드 후보 키. */
export function expectKeys(route: MockRouteSpec | null | undefined, source: 'body' | 'query' | 'header' | 'path'): string[] {
  if (!route) return []
  if (source === 'path') return pathParamNames(route.path)
  return (route.expect?.[source] ?? []).map((f) => f.key?.trim() ?? '').filter(Boolean)
}

/** textarea 캐럿 위치에 텍스트 삽입 — 응답 본문/콜백 본문 같은 여러 줄 필드의 `{ }` 데이터 삽입. */
export function insertAtCaret(el: HTMLTextAreaElement | null, current: string, text: string): string {
  if (!el) return current + text
  const s = el.selectionStart ?? current.length
  const e = el.selectionEnd ?? s
  const next = current.slice(0, s) + text + current.slice(e)
  requestAnimationFrame(() => { try { el.focus(); el.setSelectionRange(s + text.length, s + text.length) } catch { /* */ } })
  return next
}
