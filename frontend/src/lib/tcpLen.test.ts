import { describe, expect, it } from 'vitest'
import {
  incomingFrameLine, isBuiltinTokenKey, isLenFieldName, isLenTokenKey, isTimeTokenKey,
  lenFieldWarning, lenFrameToken, lenToken, literalLenValue,
  outgoingFrameLine, padNum, receivedBytes, receivedCompare, requestFrameLine, sumFieldBytes, tcpFrame,
} from './tcpLen'
import { tokenRegex } from './tokenGrammar'

describe('tcpFrame — 본문 / 프리픽스 / 전송', () => {
  it('프리픽스 포함 길이 켜짐 = 프리픽스에 전송 길이(사용자 실제 사례 204/4/208)', () => {
    const f = tcpFrame(204, 4, true)
    expect(f).toMatchObject({ body: 204, prefix: 4, frame: 208, declared: 208, declaredText: '0208', includesSelf: true })
  })

  it('프리픽스 포함 길이 꺼짐 = 프리픽스에 본문 길이', () => {
    const f = tcpFrame(204, 4, false)
    expect(f).toMatchObject({ frame: 208, declared: 204, declaredText: '0204' })
  })

  it('프리픽스 0 = 없음(전송 = 본문)', () => {
    const f = tcpFrame(204, 0, true)
    expect(f).toMatchObject({ prefix: 0, frame: 204, declaredText: '' })
  })

  it('프리픽스 폭만큼 0 패딩 · 넘치면 하위 자리(백엔드 TcpBytes.prefix 규약)', () => {
    expect(padNum(204, 4)).toBe('0204')
    expect(padNum(7, 6)).toBe('000007')
    expect(padNum(12345, 4)).toBe('2345')
    expect(padNum(12, 0)).toBe('12')
    expect(tcpFrame(99999, 4, false).declaredText).toBe('9999')
  })

  it('음수·소수·누락은 0 으로 방어', () => {
    expect(tcpFrame(-5, -2, null)).toMatchObject({ body: 0, prefix: 0, frame: 0 })
    expect(sumFieldBytes([{ length: 4 }, { length: 200 }, { length: null }, {}])).toBe(204)
    expect(sumFieldBytes(null)).toBe(0)
  })
})

describe('요약 줄 — 세 숫자를 한 줄로', () => {
  it('노드 요청(내가 보낸다)', () => {
    expect(requestFrameLine(tcpFrame(204, 4, true)))
      .toBe('본문 204B + 프리픽스 4B = 전송 208B · 프리픽스 값 "0208"(포함 길이 켜짐)')
    expect(requestFrameLine(tcpFrame(204, 4, false)))
      .toBe('본문 204B + 프리픽스 4B = 전송 208B · 프리픽스 값 "0204"(포함 길이 꺼짐)')
    expect(requestFrameLine(tcpFrame(204, 0, false)))
      .toBe('본문 204B · 프리픽스 없음 — 연결당 1전문(EOF)')
  })

  it('Mock 요청 레이아웃(내가 받는다 — 들어올 전문의 모습)', () => {
    expect(incomingFrameLine(tcpFrame(200, 4, true)))
      .toBe('본문 200B 를 기다림 · 프리픽스 4B 값 "0204"(포함 길이 켜짐 · 끄면 "0200")')
    expect(incomingFrameLine(tcpFrame(200, 4, false)))
      .toBe('본문 200B 를 기다림 · 프리픽스 4B 값 "0200"(포함 길이 꺼짐 · 끄면 "0204")')
    expect(incomingFrameLine(tcpFrame(200, 0, false)))
      .toBe('본문 200B 를 기다림 · 프리픽스 없음 — 연결당 1전문(EOF)')
  })

  it('Mock 규칙 응답(내가 보낸다)', () => {
    expect(outgoingFrameLine(tcpFrame(40, 4, true))).toBe('응답 본문 40B + 프리픽스 4B = 나가는 전문 44B')
    expect(outgoingFrameLine(tcpFrame(40, 0, false))).toBe('응답 본문 40B · 프리픽스 없음')
  })
})

describe('전문 안 길이 필드 판별', () => {
  it('이름이 길이 필드로 보이는 것만', () => {
    for (const n of ['length', 'LENGTH', 'len', 'Len', '길이', '전문길이', '전체길이', 'msgLen', 'msg_length', 'body-len', '데이터길이'])
      expect(isLenFieldName(n), n).toBe(true)
    for (const n of ['', '  ', '전문코드', '계좌번호', '고객명', 'amount', '금액', 'code'])
      expect(isLenFieldName(n), n).toBe(false)
  })

  it('숫자 리터럴만 판정 대상 — 토큰·문자 섞인 값은 판단하지 않음', () => {
    expect(literalLenValue('0200')).toBe(200)
    expect(literalLenValue(' 208 ')).toBe(208)
    expect(literalLenValue('{{len:4}}')).toBeNull()
    expect(literalLenValue('{{ 길이@req }}')).toBeNull()
    expect(literalLenValue('20O')).toBeNull()
    expect(literalLenValue('')).toBeNull()
    expect(literalLenValue(null)).toBeNull()
  })

  it('본문·전송 어느 쪽과도 다르면 경고(사용자 사례: 204/208 인데 "0200")', () => {
    const f = tcpFrame(204, 4, true)
    expect(lenFieldWarning({ name: 'length', length: 4, value: '0200' }, f))
      .toBe('본문 204B · 전송 208B 와 다릅니다 — {{len:4}} 를 쓰면 자동으로 채워집니다')
  })

  it('본문 또는 전송과 같으면 경고 없음(프로토콜 규약 차이)', () => {
    const f = tcpFrame(204, 4, true)
    expect(lenFieldWarning({ name: 'length', length: 4, value: '0204' }, f)).toBeNull()
    expect(lenFieldWarning({ name: 'length', length: 4, value: '0208' }, f)).toBeNull()
    expect(lenFieldWarning({ name: 'length', length: 4, value: '{{len:4}}' }, f)).toBeNull()
    expect(lenFieldWarning({ name: '계좌번호', length: 4, value: '0200' }, f)).toBeNull()
  })

  it('{{len}} 토큰은 그 필드의 길이만큼 0 패딩', () => {
    expect(lenToken(4)).toBe('{{len:4}}')
    expect(lenToken(6)).toBe('{{len:6}}')
    expect(lenToken(0)).toBe('{{len}}')
    expect(lenToken(null)).toBe('{{len}}')
  })

  it('폭은 백엔드가 인정하는 3자리(999)로 클램프 — {{len:1000}} 은 치환이 안 돼 조용히 깨진다', () => {
    expect(lenToken(999)).toBe('{{len:999}}')
    expect(lenToken(1000)).toBe('{{len:999}}')
    expect(lenToken(4096)).toBe('{{len:999}}')
    expect(lenToken(-3)).toBe('{{len}}')
    // 만들어 낸 토큰은 전부 백엔드가 인정하는 형태여야 한다
    for (const w of [1, 4, 999, 1000, 4096, 0, null]) {
      expect(isLenTokenKey(lenToken(w).slice(2, -2)), String(w)).toBe(true)
      expect(isLenTokenKey(lenFrameToken(w).slice(2, -2)), String(w)).toBe(true)
    }
  })

  it('안내 문구의 프리픽스 포함 토큰도 같은 정규화(길이 없는 필드에 {{len:frame:0}} 금지)', () => {
    expect(lenFrameToken(4)).toBe('{{len:frame:4}}')
    expect(lenFrameToken(0)).toBe('{{len:frame}}')
    expect(lenFrameToken(undefined)).toBe('{{len:frame}}')
    expect(lenFrameToken(1000)).toBe('{{len:frame:999}}')
  })
})

describe('소스 없는 내장 토큰 — "이전 노드 값 입력" 후보에서 제외', () => {
  it('길이 토큰 형태만 인식(백엔드 TcpLen.INNER 미러)', () => {
    for (const k of ['len', 'len:4', 'len:999', 'len:frame', 'len:frame:4', 'len : frame : 4', ' len ', 'len:1'])
      expect(isLenTokenKey(k), k).toBe(true)
    for (const k of ['length', 'lenient', 'LEN', 'Len:4', 'len:x', 'len:1234', 'len:frame:1234', 'lens', '길이', 'frame', '', 'len:4:frame'])
      expect(isLenTokenKey(k), k).toBe(false)
  })

  it('시각 토큰 형태(now/today/time · now:패턴)', () => {
    for (const k of ['now', 'today', 'time', 'now:yyyyMMdd', 'now:yyyy-MM-dd HH:mm', 'today:yyyyMMdd'])
      expect(isTimeTokenKey(k), k).toBe(true)
    for (const k of ['nowhere', 'timeout', 'NOW', 'now:', '시각', 'time2'])
      expect(isTimeTokenKey(k), k).toBe(false)
  })

  it('isBuiltinTokenKey = 길이 ∪ 시각 · 상위 노드 출력 키는 그대로 후보', () => {
    expect(isBuiltinTokenKey('len:4')).toBe(true)
    expect(isBuiltinTokenKey('now:yyyyMMdd')).toBe(true)
    for (const k of ['amount', '계좌번호', 'user.name', 'items[0].id', 'length', 'timeout'])
      expect(isBuiltinTokenKey(k), k).toBe(false)
  })

  it('실제 토큰 문법으로 뽑은 키에도 그대로 적용된다(PropertyPanel 의 detectUpstreamTokens 경로)', () => {
    const graph = JSON.stringify({ a: '{{len:4}}', b: '{{ now:yyyyMMdd }}', c: '{{ 계좌번호@n1 }}', d: '{{ amount }}', e: '{{len:frame:4}}' })
    // 전제: 길이/시각 토큰도 문법상 토큰이라 스캐너에 잡힌다(그래서 걸러내야 한다)
    expect(graph.match(tokenRegex())).toHaveLength(5)
    const re = tokenRegex()
    const asked: string[] = []
    for (let m = re.exec(graph); m; m = re.exec(graph)) {
      const key = m[1]
      const src = m[3] ?? null
      if (src == null && isBuiltinTokenKey(key)) continue // PropertyPanel 과 같은 판정
      asked.push(`${key}@${src ?? ''}`)
    }
    expect(asked).toEqual(['계좌번호@n1', 'amount@'])
  })
})

describe('응답 선언 vs 실제 수신', () => {
  it('백엔드 기록 형식(`응답 200B\\n…`)에서 수신 바이트', () => {
    expect(receivedBytes('응답 200B\n0000홍길동')).toBe(200)
    expect(receivedBytes('응답 0B')).toBe(0)
    expect(receivedBytes('⚠ TCP 요청 실패: timeout')).toBeNull()
    expect(receivedBytes(null)).toBeNull()
  })

  it('같으면 ✓, 다르면 모자람/남음', () => {
    expect(receivedCompare(204, 204)).toEqual({ ok: true, text: '선언 204B / 수신 204B ✓' })
    expect(receivedCompare(204, 200)).toEqual({ ok: false, text: '선언 204B / 수신 200B ⚠ 4B 모자람' })
    expect(receivedCompare(200, 204)).toEqual({ ok: false, text: '선언 200B / 수신 204B ⚠ 4B 남음' })
  })
})
