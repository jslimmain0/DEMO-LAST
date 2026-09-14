import { describe, expect, it } from 'vitest'
import { bindingToToken, isTokenizable, parseToken, segmentValue } from './tokenGrammar'

/**
 * 백엔드 문법(TokenResolver.TOKEN ∪ common/tcp/TcpLen)의 프론트 미러 고정.
 * 여기서 토큰으로 잡히는 것만 TokenInput 에서 칩이 되고, 아닌 것은 평문으로 남는다.
 */
describe('tokenGrammar — 기존 문법(무회귀)', () => {
  it('bare · 명시 소스 · 요청 스코프', () => {
    expect(parseToken('{{ amount }}')).toEqual({ key: 'amount', scope: null, sourceId: null })
    expect(parseToken('{{ acct@set1 }}')).toEqual({ key: 'acct', scope: null, sourceId: 'set1' })
    expect(parseToken('{{ acct@req:node-1 }}')).toEqual({ key: 'acct', scope: 'req', sourceId: 'node-1' })
  })

  it('중첩 경로 · 한글 키 · 현재 일시', () => {
    expect(parseToken('{{ items[0].id@n1 }}')?.key).toBe('items[0].id')
    expect(parseToken('{{ 고객명@n1 }}')?.key).toBe('고객명')
    expect(parseToken('{{ now:yyyyMMddHHmmss }}')?.key).toBe('now:yyyyMMddHHmmss')
    expect(parseToken('{{ now:yyyyMMdd@UTC }}')).toEqual({ key: 'now:yyyyMMdd', scope: null, sourceId: 'UTC' })
  })

  it('토큰이 아닌 것', () => {
    expect(parseToken('{{ }}')).toBeNull()
    expect(parseToken('그냥 텍스트')).toBeNull()
  })
})

describe('tokenGrammar — TCP 전문 길이 토큰(백엔드 TcpLen 과 동일)', () => {
  it('네 형태 모두 하나의 토큰(소스 없음)', () => {
    expect(parseToken('{{len}}')).toEqual({ key: 'len', scope: null, sourceId: null })
    expect(parseToken('{{len:4}}')).toEqual({ key: 'len:4', scope: null, sourceId: null })
    expect(parseToken('{{len:frame}}')).toEqual({ key: 'len:frame', scope: null, sourceId: null })
    expect(parseToken('{{len:frame:4}}')).toEqual({ key: 'len:frame:4', scope: null, sourceId: null })
    expect(parseToken('{{ len : frame : 4 }}')?.key).toBe('len : frame : 4') // 공백 허용(백엔드와 동일)
  })

  it('백엔드가 안 읽는 형태는 길이 토큰이 아니다', () => {
    expect(parseToken('{{len:x}}')).toBeNull()       // 자리수도 frame 도 아님
    expect(parseToken('{{LEN:4}}')).toBeNull()       // 대문자(백엔드는 소문자 고정)
    expect(parseToken('{{len:1234}}')).toBeNull()    // 자리수는 1~3자리까지
    expect(parseToken('{{len:4:5}}')).toBeNull()
    expect(parseToken('{{ len:4@n1 }}')).toBeNull()  // 길이 토큰엔 소스가 없고, 일반 키 클래스엔 ':' 이 없다
  })

  it('길이 토큰이 아닌 len* 는 예전 그대로 일반 바인딩', () => {
    // {{length}}·{{LEN}} 은 백엔드 TokenResolver 가 읽는 bare 키(길이 토큰이 아닐 뿐) — 칩으로 남아야 무회귀
    expect(parseToken('{{length}}')).toEqual({ key: 'length', scope: null, sourceId: null })
    expect(parseToken('{{LEN}}')).toEqual({ key: 'LEN', scope: null, sourceId: null })
    expect(parseToken('{{ len@n1 }}')).toEqual({ key: 'len', scope: null, sourceId: 'n1' })
    expect(parseToken('{{ lender@n1 }}')).toEqual({ key: 'lender', scope: null, sourceId: 'n1' })
  })

  it('문자열 안에서 칩 구간으로 분해된다', () => {
    expect(segmentValue('ABC{{len:4}}0200')).toEqual([
      { type: 'text', text: 'ABC' },
      { type: 'token', raw: '{{len:4}}' },
      { type: 'text', text: '0200' },
    ])
    expect(segmentValue('{{len:4}}{{ acct@n1 }}')).toEqual([
      { type: 'token', raw: '{{len:4}}' },
      { type: 'token', raw: '{{ acct@n1 }}' },
    ])
    // 인식 안 되는 형태는 평문 그대로
    expect(segmentValue('{{len:x}}')).toEqual([{ type: 'text', text: '{{len:x}}' }])
  })

  it('구조적 바인딩 이관 판정은 영향 없음(len 키가 소스와 함께면 여전히 토큰화 가능)', () => {
    expect(isTokenizable({ key: 'len', sourceId: 'n1', scope: null })).toBe(true)
    expect(isTokenizable({ key: 'len:4', sourceId: 'n1', scope: null })).toBe(false) // 해석 불능 → bound 유지
    expect(bindingToToken({ key: 'len', sourceId: 'n1', scope: null })).toBe('{{ len@n1 }}')
  })
})
