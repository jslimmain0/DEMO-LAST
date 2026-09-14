import { describe, expect, it } from 'vitest'
import { detectPrefix } from './tcpSample'

describe('detectPrefix', () => {
  it('앞 4자리 = 본문 길이 → 자기 미포함', () => expect(detectPrefix('001402001234567890', 4).kind).toBe('excl'))
  it('앞 4자리 = 전체 길이 → 포함', () => expect(detectPrefix('001802001234567890', 4).kind).toBe('incl'))
  it('불일치', () => expect(detectPrefix('999902001234567890', 4).kind).toBe('mismatch'))
  it('프리픽스 없음/숫자 아님', () => { expect(detectPrefix('02001234', 0).kind).toBe('none'); expect(detectPrefix('AB0012', 4).kind).toBe('none') })
})
