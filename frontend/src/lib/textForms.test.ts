import { describe, expect, it } from 'vitest'
import { normalizeLayoutRow, parseTcpLayout, tcpLayoutForm, tcpLayoutToText, type LayoutRow } from './textForms'

const strip = (rows: LayoutRow[], mode: 'request' | 'response' | 'layout') => rows.map((r) => { const { id: _id, ...rest } = normalizeLayoutRow(r, mode); return rest })

describe('tcp DSL — request 모드(값·패딩)', () => {
  it('직렬화 → 파싱 왕복(정규화 기준 동일)', () => {
    const rows: LayoutRow[] = [
      { id: 'a', name: '전문코드', length: 4, value: '0200', pad: 'right', padChar: ' ' },
      { id: 'b', name: '계좌번호', length: 12, value: '{{ acct@set1 }}', pad: 'left', padChar: '0' },
      { id: 'c', name: '송신 기관코드', length: 8, value: '', pad: 'right', padChar: '*', encoding: 'UTF-8' },
      { id: 'd', name: '비고', length: 10, value: ' 앞공백 ' },
    ]
    const text = tcpLayoutToText(rows, 'request')
    expect(text.split('\n')[0]).toBe('전문코드 4 문자 = 0200')
    expect(text.split('\n')[1]).toBe('계좌번호 12 숫자 = {{ acct@set1 }}')
    expect(text.split('\n')[2]).toBe('"송신 기관코드" 8 R* UTF-8')
    expect(text.split('\n')[3]).toBe('비고 10 문자 = " 앞공백 "')
    const back = parseTcpLayout(text, 'request', rows)
    expect(back.warnings).toEqual([])
    expect(back.rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']) // prev id 승계(위치+이름)
    expect(strip(back.rows, 'request')).toEqual(strip(rows, 'request'))
  })
  it('종류 별칭·PIC·패딩 이스케이프·주석·빈 줄', () => {
    const { rows, warnings } = parseTcpLayout('# 주석\n\n금액 X(10) N\n이름 9(3)V99\n구분 1 L\\,\n코드 2 R_ ms949', 'request')
    expect(warnings).toEqual([])
    expect(rows.map((r) => [r.name, r.length, r.pad, r.padChar, r.encoding])).toEqual([
      ['금액', 10, 'left', '0', undefined],   // 명시 종류 N 이 PIC 의 X 보다 우선
      ['이름', 5, 'left', '0', undefined],    // 9(3)V99 = 3+2, 숫자
      ['구분', 1, 'left', ',', undefined],
      ['코드', 2, 'right', ' ', 'MS949'],
    ])
  })
  it('실패 줄은 경고로, 나머지는 살아남는다(throw 없음)', () => {
    const { rows, warnings } = parseTcpLayout('ok 4\n길이없음\n이상 abc\nfine 2 = x', 'request')
    expect(rows.map((r) => r.name)).toEqual(['ok', 'fine'])
    expect(warnings.map((w) => w.line)).toEqual([2, 3])
  })
  it('bound 복원: 텍스트가 같은 토큰이면 prev 의 bound 유지', () => {
    const prev: LayoutRow[] = [{ id: 'x', name: 'k', length: 4, value: null, bound: { key: 'amt', sourceId: 'n1', scope: 'out' } as never }]
    const text = tcpLayoutToText(prev, 'request')
    expect(text).toBe('k 4 문자 = {{ amt@n1 }}')
    const back = parseTcpLayout(text, 'request', prev)
    expect(back.rows[0].bound).toEqual(prev[0].bound)
    expect(back.rows[0].value).toBeNull()
  })
})

describe('tcp DSL — 엑셀 TSV 헤더 매핑', () => {
  it('항목명/길이/타입/기본값 열을 찾아 매핑, 순번 열 무시', () => {
    const tsv = '순번\t항목명\t길이\t타입\t기본값\t설명\n1\t전문코드\t4\tAN\t0200\t거래코드\n2\t계좌번호\t12\tN\t\t좌측 0\n3\t고객명\t10\tK\t\t한글'
    const r = parseTcpLayout(tsv, 'request')
    expect(r.headerMapped).toBe(true)
    expect(r.warnings).toEqual([])
    expect(r.rows.map((x) => [x.name, x.length, x.pad, x.padChar, x.value])).toEqual([
      ['전문코드', 4, 'right', ' ', '0200'], ['계좌번호', 12, 'left', '0', ''], ['고객명', 10, 'right', ' ', ''],
    ])
  })
  it('마크다운 표(| 구분·--- 줄)도 같은 규칙', () => {
    const md = '| 항목 | 길이 | 유형 |\n|---|---|---|\n| 코드 | 4 | X |\n| 금액 | 8 | 9 |'
    const r = parseTcpLayout(md, 'layout')
    expect(r.rows.map((x) => [x.name, x.length])).toEqual([['코드', 4], ['금액', 8]])
  })
})

describe('tcp DSL — response/layout 모드', () => {
  it('response: 종류가 type/trim 이 되고 값은 무시(경고)', () => {
    const r = parseTcpLayout('응답코드 4 문자\n잔액 12 숫자\n고객명 10 = 무시됨', 'response')
    expect(r.rows.map((x) => [x.name, x.length, x.type, x.trim])).toEqual([['응답코드', 4, 'string', true], ['잔액', 12, 'number', true], ['고객명', 10, undefined, undefined]])
    expect(r.warnings).toHaveLength(1)
    expect(tcpLayoutToText(r.rows, 'response')).toBe('응답코드 4 문자\n잔액 12 숫자\n고객명 10')
  })
  it('layout: 이름·길이·인코딩만', () => {
    const rows: LayoutRow[] = [{ id: '1', name: '전문코드', length: 4 }, { id: '2', name: '고객명', length: 10, encoding: 'EUC-KR' }]
    const text = tcpLayoutToText(rows, 'layout')
    expect(text).toBe('전문코드 4\n고객명 10 EUC-KR')
    expect(strip(parseTcpLayout(text, 'layout', rows).rows, 'layout')).toEqual(strip(rows, 'layout'))
  })
  it('TextForm 계약: form.fromText(form.toText(rows)) ≡ rows', () => {
    const form = tcpLayoutForm('request')
    const rows: LayoutRow[] = [{ id: 'q', name: 'a', length: 3, value: 'x', pad: 'right', padChar: ' ' }]
    expect(strip(form.fromText(form.toText(rows), rows).rows, 'request')).toEqual(strip(rows, 'request'))
  })
})
