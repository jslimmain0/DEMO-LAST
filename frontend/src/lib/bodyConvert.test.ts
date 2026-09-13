import { describe, expect, it } from 'vitest'
import { fieldsToRaw, rawToFields, headersToRaw, rawToHeaders } from './bodyConvert'

describe('bodyConvert 왕복', () => {
  it('json 필드 → raw → 필드 (타입 보존)', () => {
    const rows = [{ key: 'name', value: 'kim', type: 'string' }, { key: 'age', value: '30', type: 'number' }, { key: 'ok', value: 'true', type: 'boolean' }]
    const back = rawToFields(fieldsToRaw(rows, 'json'), 'json')
    expect(back).toEqual(rows)
  })
  it('urlencoded 왕복', () => {
    const rows = [{ key: 'a', value: '1' }, { key: 'b', value: 'x y' }]
    expect(rawToFields(fieldsToRaw(rows, 'urlencoded'), 'urlencoded')).toEqual(rows)
  })
  it('헤더: 콜론 없는 줄이 있으면 null', () => {
    expect(rawToHeaders('A: 1\nbroken')).toBeNull()
    expect(rawToHeaders(headersToRaw([{ key: 'A', value: '1' }]))).toEqual([{ key: 'A', value: '1' }])
  })
})
