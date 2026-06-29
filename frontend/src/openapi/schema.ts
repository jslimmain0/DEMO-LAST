// OpenAPI 3.x / Swagger 2.0 스키마 해석 헬퍼. 순수 함수(런타임 의존성 없음 → 단위 테스트 가능).
// refs(중첩 포함)·배열 언랩·allOf 병합·다양한 2xx 응답코드·응답레벨 $ref 를 처리한다.
export interface AnyObj {
  [k: string]: unknown
}
export interface RefCtx {
  components: AnyObj // components.schemas (openapi3)
  swaggerDefs: AnyObj // definitions (swagger2)
  responses: AnyObj // components.responses (openapi3, 응답레벨 $ref)
}
export interface Prop {
  key: string
  type: string
}

export function obj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {}
}
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function mapType(schema: AnyObj): string {
  const t = str(schema.type)
  if (t === 'integer') return 'int'
  if (t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'array') return 'array'
  if (t === 'object') return 'object'
  if (schema.$ref) return 'object'
  return t || 'string'
}

/** $ref 해석(중첩 포함). schemas/definitions/responses 어디든 이름으로 찾는다. */
export function resolveRef(schema: AnyObj | undefined, ctx: RefCtx, depth = 0): AnyObj {
  if (!schema || depth > 6) return schema ?? {}
  const ref = str(schema.$ref)
  if (!ref) return schema
  const name = ref.split('/').pop() ?? ''
  const target = obj(ctx.components[name] ?? ctx.swaggerDefs[name] ?? ctx.responses[name])
  return resolveRef(target, ctx, depth + 1)
}

/** 스키마 → 최상위 프로퍼티 목록. 배열이면 items 로 언랩(목록 API), allOf 면 병합. */
export function propsOf(schema: AnyObj | undefined, ctx: RefCtx): Prop[] {
  let s = resolveRef(schema, ctx)
  if (str(s.type) === 'array' || s.items !== undefined) {
    s = resolveRef(obj(s.items), ctx) // 배열 응답: items 의 필드를 사용
  }
  if (Array.isArray(s.allOf)) {
    const merged: AnyObj = {}
    for (const part of arr(s.allOf)) {
      Object.assign(merged, obj(resolveRef(obj(part), ctx).properties))
    }
    if (Object.keys(merged).length > 0) {
      return Object.keys(merged).map((k) => ({ key: k, type: mapType(obj(merged[k])) }))
    }
  }
  const properties = obj(s.properties)
  return Object.keys(properties).map((k) => ({ key: k, type: mapType(obj(properties[k])) }))
}

/** 성공 응답(2xx/default)의 본문 스키마. 응답레벨 $ref·openapi3 content·swagger2 schema·임의 json 미디어타입 처리. */
export function responseSchema(responses: AnyObj, ctx: RefCtx): AnyObj | undefined {
  let r = resolveRef(obj(pickSuccess(responses)), ctx) // 응답레벨 $ref 해석
  const content = obj(r.content)
  const json = obj(content['application/json'] ?? firstJsonContent(content))
  let schema = obj(json.schema)
  if (Object.keys(schema).length > 0) return schema
  schema = obj(r.schema) // swagger2
  return Object.keys(schema).length > 0 ? schema : undefined
}

function pickSuccess(responses: AnyObj): unknown {
  if (responses['200'] !== undefined) return responses['200']
  if (responses['201'] !== undefined) return responses['201']
  for (const k of Object.keys(responses)) {
    if (k === '2XX' || k === '2xx' || (k.length === 3 && k[0] === '2')) return responses[k]
  }
  return responses.default
}

function firstJsonContent(content: AnyObj): unknown {
  // application/json 이 없으면 *+json 또는 첫 미디어타입 사용
  for (const k of Object.keys(content)) {
    if (k.includes('json')) return content[k]
  }
  for (const k of Object.keys(content)) {
    if (content[k] && typeof content[k] === 'object') return content[k]
  }
  return undefined
}
