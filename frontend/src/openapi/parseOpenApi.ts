// OpenAPI 3.x / Swagger 2.0 문서를 파싱해 워크플로 HTTP 노드로 변환한다.
// 스키마 해석(refs·배열·allOf·다양한 2xx·응답레벨 ref)은 ./schema 의 순수 함수에 위임(단위 테스트 가능).
import type { GraphNode, HttpMethod, NodeField, NodeOutput } from '../api/types'
import { newId } from '../lib/ids'
import { arr, obj, propsOf, responseSchema, str } from './schema'
import type { AnyObj, RefCtx } from './schema'

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']

export interface ParsedOperation {
  key: string
  method: HttpMethod
  path: string
  summary: string
  build: (x: number, y: number) => GraphNode
}

export interface ParsedDoc {
  title: string
  baseUrl: string
  operations: ParsedOperation[]
}

// OpenAPI 스키마 타입 → 우리 NodeField/Output 타입(따옴표 여부 등)
function fieldType(openapiType: string): string {
  if (openapiType === 'int' || openapiType === 'number') return 'number'
  if (openapiType === 'boolean') return 'boolean'
  if (openapiType === 'array') return 'array'
  if (openapiType === 'object') return 'json'
  return 'string'
}

export function parseOpenApi(raw: string): ParsedDoc {
  let doc: AnyObj
  try {
    doc = JSON.parse(raw) as AnyObj
  } catch {
    throw new Error('JSON 파싱 실패 — 올바른 OpenAPI/Swagger JSON인지 확인하세요. (YAML은 미지원)')
  }
  const title = str(obj(doc.info).title) || 'OpenAPI'
  const baseUrl = resolveBaseUrl(doc)
  const ctx: RefCtx = {
    components: obj(obj(doc.components).schemas),
    swaggerDefs: obj(doc.definitions),
    responses: obj(obj(doc.components).responses),
  }

  const paths = obj(doc.paths)
  const operations: ParsedOperation[] = []

  for (const path of Object.keys(paths)) {
    const item = obj(paths[path])
    for (const method of HTTP_METHODS) {
      const rawOp = item[method.toLowerCase()]
      if (!rawOp || typeof rawOp !== 'object') continue
      const o = obj(rawOp)
      const summary = str(o.summary) || str(o.operationId) || `${method} ${path}`

      const params: NodeField[] = []
      const headers: NodeField[] = []
      const paramList = [...arr(item.parameters), ...arr(o.parameters)]
      for (const p of paramList) {
        const pp = obj(p)
        const name = str(pp.name)
        const loc = str(pp.in)
        if (!name) continue
        if (loc === 'query') params.push({ id: newId(), key: name, value: '' })
        else if (loc === 'header') headers.push({ id: newId(), key: name, value: '' })
      }

      // requestBody(openapi3) 또는 swagger2 body parameter → 바디 필드(+타입)
      const body: NodeField[] = []
      const reqSchema = jsonSchema(obj(o.requestBody))
      const bodyProps = reqSchema ? propsOf(reqSchema, ctx) : swagger2BodyProps(paramList, ctx)
      for (const bp of bodyProps) body.push({ id: newId(), key: bp.key, value: '', type: fieldType(bp.type) })

      // 성공 응답 → outputs(+타입). 배열/ref/allOf/2xx 모두 처리.
      const respSchema = responseSchema(obj(o.responses), ctx)
      const outputs: NodeOutput[] = (respSchema ? propsOf(respSchema, ctx) : []).map((p) => ({ key: p.key, type: p.type }))

      operations.push({
        key: `${method} ${path}`,
        method,
        path,
        summary,
        build: (x, y) => ({
          id: newId(),
          name: summary.slice(0, 40),
          type: 'http',
          cat: 'generic',
          method,
          baseUrl,
          path,
          bodyType: 'json',
          respType: 'json',
          reqMode: 'server',
          charset: 'UTF-8',
          x,
          y,
          fields: { params, headers, body },
          outputs,
        }),
      })
    }
  }

  return { title, baseUrl, operations }
}

function resolveBaseUrl(doc: AnyObj): string {
  const servers = arr(doc.servers)
  if (servers.length > 0) {
    const u = str(obj(servers[0]).url)
    if (u) return u.replace(/\/$/, '')
  }
  // swagger 2.0
  const host = str(doc.host)
  if (host) {
    const scheme = arr(doc.schemes)[0] ? String(arr(doc.schemes)[0]) : 'https'
    const base = str(doc.basePath) || ''
    return `${scheme}://${host}${base}`.replace(/\/$/, '')
  }
  return ''
}

function jsonSchema(requestBody: AnyObj): AnyObj | undefined {
  const content = obj(requestBody.content)
  let json = obj(content['application/json'])
  if (Object.keys(json).length === 0) {
    // application/json 이 없으면 *json 미디어타입 사용
    for (const k of Object.keys(content)) {
      if (k.includes('json')) {
        json = obj(content[k])
        break
      }
    }
  }
  const schema = obj(json.schema)
  return Object.keys(schema).length > 0 ? schema : undefined
}

function swagger2BodyProps(params: unknown[], ctx: RefCtx): Array<{ key: string; type: string }> {
  for (const p of params) {
    const pp = obj(p)
    if (str(pp.in) === 'body') {
      return propsOf(obj(pp.schema), ctx)
    }
  }
  return []
}
