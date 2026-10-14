import type { MockTcpRuleSpec, ProtocolSpec } from '../api/types'
import { fieldsOf } from './protocolSpec'

export function fixtureResponseValues(spec: ProtocolSpec, requestKey: string, responseKey: string) {
  const requestNames = new Set(fieldsOf(spec, requestKey).map(field => field.name))
  return Object.fromEntries(fieldsOf(spec, responseKey).filter(field => field.type !== 'length' && requestNames.has(field.name)).map(field => [field.name,
    spec.schemaVersion !== 2 && field.name === spec.discriminator ? responseKey.split(':')[0] : `{{req.${field.name}}}`]))
}
/** 작성 편의만 제공한다. 저장·활성화·시크릿 생성·통신사 규격 추정은 하지 않는다. */
export function makeTcpFixture(spec: ProtocolSpec, requestKey: string, responseKey: string, fields: Record<string, string>, id: string,
  mode: 'success' | 'strict', requestValues: Record<string, string>, successField: string, successValue: string): MockTcpRuleSpec {
  if (!spec.messages.some(message => message.key === requestKey) || !spec.messages.some(message => message.key === responseKey)) throw new Error('등록된 요청·응답 전문을 선택하세요.')
  const transaction = spec.schemaVersion === 2 ? (spec.transactions ?? []).find(entry => entry.requestMessage === requestKey && entry.responseMessage === responseKey) : undefined
  if (spec.schemaVersion === 2 && !transaction) throw new Error('요청·응답 전문이 같은 거래의 정의여야 합니다.')
  const responseFields = fieldsOf(spec, responseKey).filter(field => field.type !== 'length')
  const output = { ...fields }
  if (mode === 'success') {
    if (!successField || !successValue.trim() || !responseFields.some(field => field.name === successField)) throw new Error('규격의 성공 코드 필드와 값을 직접 지정하세요.')
    output[successField] = successValue
  }
  const missing = responseFields.filter(field => !Object.hasOwn(output, field.name))
  if (missing.length) throw new Error(`필수 응답 값을 지정하세요: ${missing.map(field => field.name).join(', ')}`)
  const when = transaction ? transaction.when.map(condition => ({ ...condition })) : spec.discriminator ? [{ field: spec.discriminator, op: 'eq' as const, value: requestKey.split(':')[0] }] : []
  if (mode === 'strict') for (const field of fieldsOf(spec, requestKey)) {
    if (field.type === 'length' || !Object.hasOwn(requestValues, field.name) || when.some(condition => condition.field === field.name)) continue
    when.push({ field: field.name, op: 'eq', value: requestValues[field.name] })
  }
  return { id, when, then: { mode: 'mock', fields: Object.fromEntries(responseFields.map(field => [field.name, output[field.name]])) } }
}
