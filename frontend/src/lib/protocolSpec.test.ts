// frontend/src/lib/protocolSpec.test.ts — 실행: cd frontend && node src/lib/protocolSpec.test.ts
import assert from 'node:assert/strict'
import { byteLen, lengthNumbers, lintTcpRules, newProtocolSpec, parsePastedTable, splitPasted, withOffsets } from './protocolSpec.ts'
import type { ProtocolSpec } from '../api/types.ts'

const spec: ProtocolSpec = {
  encoding: 'EUC-KR', lengthField: '전문길이', lengthFormat: 'ascii-decimal', includesSelf: false, discriminator: '거래코드',
  header: [{ name: '전문길이', len: 4, type: 'length', pad: 'left/zero' }, { name: '거래코드', len: 4, type: 'ascii', pad: 'right/space' }],
  messages: [
    { key: '0210', label: '요청', fields: [{ name: '계좌번호', len: 13, type: 'ascii' }, { name: '고객명', len: 20, type: 'string' }, { name: '금액', len: 15, type: 'numeric' }] },
    { key: '0211', label: '응답', fields: [{ name: '응답코드', len: 4, type: 'ascii' }, { name: '잔액', len: 15, type: 'numeric' }] },
  ],
}

assert.deepEqual(withOffsets(spec.header, spec.messages[0].fields), [8, 21, 41])
assert.deepEqual(lengthNumbers(spec, '0210'), { total: 56, bodyOnly: 52, withSelf: 56 })
assert.equal(byteLen('김철수', 'EUC-KR'), 6)
assert.equal(byteLen('김철수', 'UTF-8'), 9)
assert.equal(byteLen('abc', 'EUC-KR'), 3)

const pasted = parsePastedTable(`
      name        len  type     pad          (offset)
  1   전문길이      4   length   left/zero     0
  2   거래코드      4   ascii    right/space   4
  3   계좌번호     13   ascii    right/space   8
  4   고객명       20   string   right/space  21
  5   금액         15   numeric  left/zero    41
`)
assert.equal(pasted.fields.length, 5)
assert.deepEqual(pasted.fields[0], { name: '전문길이', len: 4, type: 'length', pad: 'left/zero' })
assert.deepEqual(pasted.fields[3], { name: '고객명', len: 20, type: 'string', pad: 'right/space' })
assert.equal(pasted.skipped.length, 1) // 제목 줄

const tabbed = parsePastedTable('계좌번호\t13\t영문\t우공백\n금액\t15\t숫자\t좌0\n비고\t10')
assert.deepEqual(tabbed.fields, [
  { name: '계좌번호', len: 13, type: 'ascii', pad: 'right/space' },
  { name: '금액', len: 15, type: 'numeric', pad: 'left/zero' },
  { name: '비고', len: 10, type: 'string', pad: 'right/space' },
])
assert.deepEqual(parsePastedTable('STX 1 ascii 0').fields, [{ name: 'STX', len: 1, type: 'ascii', pad: 'right/space' }])

const split = splitPasted(pasted.fields, spec.header)
assert.equal(split.body.length, 3)
assert.deepEqual(split.mismatches, [])
const bad = splitPasted([{ name: '전문길이', len: 4, type: 'length' }, { name: '거래구분', len: 4, type: 'ascii' }, { name: 'x', len: 1, type: 'ascii' }], spec.header)
assert.equal(bad.mismatches.length, 1)
assert.ok(bad.mismatches[0].includes('거래구분') && bad.mismatches[0].includes('거래코드'))

const lint = lintTcpRules({ port: 9600, protocolId: 'p', upstream: '', rules: [
  { id: 'a', when: [], then: { mode: 'proxy' } },
  { id: 'b', when: [], then: { mode: 'mock', fields: { 거래코드: '0211', 응답코드: '0000', 잔액: '{{req.없는필드}}', 없는키: '1', 계좌번호: '1' } } },
] }, spec)
assert.ok(lint.some((m) => m.includes('upstream')))
assert.ok(lint.some((m) => m.includes('없는필드')))
assert.ok(lint.some((m) => m.includes('없는키')))
assert.ok(lint.some((m) => m.includes('계좌번호')))     // 0211 표에 없음
const ok = lintTcpRules({ port: 1, protocolId: 'p', upstream: 'h:1', rules: [{ id: 'a', when: [], then: { mode: 'mock', fields: { 거래코드: '0211', 응답코드: '00000' } } }] }, spec)
assert.ok(ok.some((m) => m.includes('응답코드') && m.includes('5B') && m.includes('4B')))

const fresh = newProtocolSpec()
assert.equal(fresh.header[0].type, 'length')
assert.ok(fresh.messages.length >= 1)
console.log('protocolSpec tests OK')
