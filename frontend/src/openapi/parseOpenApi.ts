// OpenAPI 3.x / Swagger 2.0 문서를 파싱해 워크플로 HTTP 노드로 변환한다.
// (refs 1단계 해석, 최상위 properties 기준 — 실무 다수 케이스 커버)
import type { GraphNode, HttpMethod, NodeField, NodeOutput } from '../api/types'
import { newId } from '../lib/ids'

interface AnyObj {
  [k: string]: unknown
}

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

export function parseOpenApi(raw: string): ParsedDoc {
  let doc: AnyObj
  try {
    doc = JSON.parse(raw) as AnyObj
  } catch {
    throw new Error('JSON 파싱 실패 — 올바른 OpenAPI/Swagger JSON인지 확인하세요. (YAML은 미지원)')
  }
  const info = obj(doc.info)
  const title = str(info.title) || 'OpenAPI'
  const baseUrl = resolveBaseUrl(doc)
  const components = obj(obj(doc.components).schemas)
  const swaggerDefs = obj(doc.definitions) // swagger 2.0

  const resolveRef = (schema: AnyObj | undefined): AnyObj => {
    if (!schema) return {}
    const ref = str(schema.$ref)
    if (ref) {
      const name = ref.split('/').pop() ?? ''
      return obj(components[name] ?? swaggerDefs[name])
    }
    return schema
  }

  const propsOf = (schema: AnyObj | undefined): Array<{ key: string; type: string }> => {
    const s = resolveRef(schema)
    const properties = obj(s.properties)
    return Object.keys(properties).map((k) => ({ key: k, type: mapType(obj(properties[k])) }))
  }

  const paths = obj(doc.paths)
  const operations: ParsedOperation[] = []

  for (const path of Object.keys(paths)) {
    const item = obj(paths[path])
    for (const method of HTTP_METHODS) {
      const op = item[method.toLowerCase()]
      if (!op || typeof op !== 'object') continue
      const o = op as AnyObj
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

      // requestBody (openapi3) 또는 swagger2 body parameter
      const body: NodeField[] = []
      const reqSchema = jsonSchema(obj(o.requestBody))
      const bodyProps = reqSchema ? propsOf(reqSchema) : swagger2BodyProps(paramList, resolveRef)
      for (const bp of bodyProps) body.push({ id: newId(), key: bp.key, value: '' })

      // 200/default 응답 → outputs
      const respSchema = responseSchema(obj(o.responses))
      const outputs: NodeOutput[] = (respSchema ? propsOf(respSchema) : []).map((p) => ({ key: p.key, type: p.type }))

      const key = `${method} ${path}`
      operations.push({
        key,
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
  const json = obj(content['application/json'])
  const schema = obj(json.schema)
  return Object.keys(schema).length > 0 ? schema : undefined
}

function swagger2BodyProps(params: unknown[], resolveRef: (s: AnyObj) => AnyObj): Array<{ key: string; type: string }> {
  for (const p of params) {
    const pp = obj(p)
    if (str(pp.in) === 'body') {
      const s = resolveRef(obj(pp.schema))
      const properties = obj(s.properties)
      return Object.keys(properties).map((k) => ({ key: k, type: mapType(obj(properties[k])) }))
    }
  }
  return []
}

function responseSchema(responses: AnyObj): AnyObj | undefined {
  const r = obj(responses['200'] ?? responses['201'] ?? responses.default)
  // openapi3
  const content = obj(r.content)
  const json = obj(content['application/json'])
  if (Object.keys(obj(json.schema)).length > 0) return obj(json.schema)
  // swagger2
  if (Object.keys(obj(r.schema)).length > 0) return obj(r.schema)
  return undefined
}

function mapType(schema: AnyObj): string {
  const t = str(schema.type)
  if (t === 'integer') return 'int'
  if (t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  if (t === 'array') return 'array'
  if (t === 'object') return 'object'
  if (schema.$ref) return 'object'
  return t || 'string'
}

// --- 안전 캐스팅 헬퍼 ---
function obj(v: unknown): AnyObj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : {}
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
