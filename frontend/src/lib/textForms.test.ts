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

import { headersForm, jsonBodyForm, kvUrlForm, protectBareTokens, type KvRow } from './textForms'

describe('jsonBodyForm — bare 토큰', () => {
  it('number+단일 토큰은 따옴표 없이, 되돌리면 prev 타입 승계', () => {
    const rows: KvRow[] = [{ id: '1', key: 'amount', value: '{{ amt@prev }}', type: 'number' }, { id: '2', key: 'url', value: '/o/{{ id@n1 }}', type: 'string' }]
    const text = jsonBodyForm.toText(rows)
    expect(text).toContain('"amount": {{ amt@prev }}')
    expect(text).toContain('"url": "/o/{{ id@n1 }}"')
    const back = jsonBodyForm.fromText(text, rows)
    expect(back.warnings).toEqual([])
    expect(back.rows).toEqual(rows)
  })
  it('문자열 안의 {{ }} 는 건드리지 않는다', () => {
    const { json, tokens } = protectBareTokens('{"a": "x {{ t@n }} y", "b": {{ u@n }}}')
    expect(tokens).toEqual(['{{ u@n }}'])
    expect(JSON.parse(json)).toEqual({ a: 'x {{ t@n }} y', b: '__FLTK0__' })
  })
  it('prev 에 없는 bare 토큰은 json 타입', () => {
    const back = jsonBodyForm.fromText('{"n": {{ x@y }}}', [])
    expect(back.rows[0]).toMatchObject({ key: 'n', value: '{{ x@y }}', type: 'json' })
  })
  it('깨진 JSON 은 rows 비움 + 경고 1', () => {
    const back = jsonBodyForm.fromText('{"a": ', [])
    expect(back.rows).toEqual([]); expect(back.warnings).toHaveLength(1)
  })
})

describe('kvUrlForm — percent 대칭', () => {
  it('값의 & = 공백은 인코딩, 토큰은 그대로, 왕복 동일', () => {
    const rows: KvRow[] = [{ id: '1', key: 'q', value: 'a&b=c d' }, { id: '2', key: 'id', value: '{{ id@n1 }}-x' }]
    const text = kvUrlForm.toText(rows)
    expect(text).toBe('q=a%26b%3Dc%20d&id={{ id@n1 }}-x')
    expect(kvUrlForm.fromText(text, rows).rows).toEqual(rows)
  })
  it("'+' 는 디코딩하지 않는다(기존 raw 호환)", () => {
    expect(kvUrlForm.fromText('a=1+2', []).rows[0].value).toBe('1+2')
  })
})

describe('headersForm — 부분 허용', () => {
  it('콜론 없는 줄은 경고, 나머지는 변환', () => {
    const back = headersForm.fromText('A: 1\nbroken\nB: {{ t@secret }}', [])
    expect(back.rows.map((r) => [r.key, r.value])).toEqual([['A', '1'], ['B', '{{ t@secret }}']])
    expect(back.warnings).toEqual([{ line: 2, text: 'broken', reason: '"이름: 값" 형식이 아닙니다' }])
  })
})
