const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const plain = value => JSON.parse(JSON.stringify(value))
const jsx = (type, props) => ({ type, props })
function walk(node, predicate, output = []) { if (Array.isArray(node)) node.forEach(child => walk(child, predicate, output)); else if (node && typeof node === 'object') { if (predicate(node)) output.push(node); walk(node.props?.children, predicate, output) } return output }
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : String(node ?? '')
function load(file, modules = {}, extra = '') { const exports = {}; vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, structuredClone, TextEncoder, require: key => modules[key] ?? {} }); return exports }
const helpers = load('lib/protocolSpec.ts')
function spec() { return { schemaVersion: 2, encoding: 'UTF-8', lengthField: '', lengthFormat: 'ascii-decimal', includesSelf: false, discriminator: '', header: [{ name: 'code', len: 2, type: 'ascii', pad: 'none' }], messages: [{ key: 'pay-request', fields: [{ name: 'tid', len: 4, type: 'ascii' }, { name: 'amount', len: 8, type: 'integer', endian: 'big', signed: false }] }, { key: 'pay-response', fields: [{ name: 'tid', len: 4, type: 'ascii' }, { name: 'status', len: 2, type: 'ascii' }] }], transactions: [{ key: 'payment', when: [{ field: 'code', op: 'eq', value: 'G1' }], requestMessage: 'pay-request', responseMessage: 'pay-response', framing: { mode: 'fixed', fixedLength: 14 }, responseFraming: { mode: 'fixed', fixedLength: 8 }, requestAck: null, responseAck: { send: { kind: 'hex', hex: '06' }, receive: { kind: 'length-only', lengthBytes: 1 }, timeoutMs: 3000 } }], ackMessages: [] } }

test('v2 authoring is explicit, preserves legacy fields and emits null ACK skips without guessing message definitions', () => {
  let value = spec(); delete value.schemaVersion; delete value.transactions; delete value.ackMessages
  const original = JSON.stringify(value), states = []; let index = 0
  const { ProtocolTransactionsEditor } = load('components/ProtocolTransactionsEditor.tsx', { react: { useState: initial => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], next => states[slot] = next] } }, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../lib/protocolSpec': helpers, '../design/ui': { ui: {} } })
  const render = (readOnly = false) => { index = 0; return ProtocolTransactionsEditor({ spec: value, patch: patch => { value = { ...value, ...patch } }, readOnly, codecs: [], frameEditor: () => null }) }
  let tree = render()
  assert.equal(JSON.stringify(value), original, 'viewing never migrates legacy saved definitions')
  walk(tree, node => node.props?.['aria-label'] === '거래별 설정 사용')[0].props.onChange({ target: { checked: true } })
  assert.equal(value.schemaVersion, 2); assert.equal(JSON.stringify(value.header), JSON.stringify(JSON.parse(original).header))
  tree = render(); walk(tree, node => node.type === 'button' && text(node) === '+ 거래 추가')[0].props.onClick()
  assert.equal(value.transactions[0].requestAck, null); assert.equal(value.transactions[0].responseAck, null)
  assert.equal(value.transactions[0].requestMessage, ''); assert.equal(value.transactions[0].responseMessage, '')
  assert.equal(walk(render(), node => node.props?.['aria-label'] === '거래별 설정 사용')[0].props.disabled, true, 'populated v2 definitions cannot be silently discarded by toggling')
  assert.ok(walk(render(true), node => node.type === 'input' || node.type === 'select').every(node => node.props.readOnly || node.props.disabled))
})

test('ACK send and receive modes stay independent and switching modes removes incompatible serialized properties', () => {
  const { AckEditor } = load('components/ProtocolTransactionsEditor.tsx', { 'react/jsx-runtime': { jsx, jsxs: jsx }, '../design/ui': { ui: {} } }, '\nexports.AckEditor = AckEditor;')
  let value = null
  const render = () => AckEditor({ label: '응답 ACK', value, spec: spec(), readOnly: false, onChange: next => value = next })
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 사용')[0].props.onChange({ target: { checked: true } })
  assert.equal(value.send.kind, 'hex'); assert.equal(value.receive.kind, 'length-only')
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 송신 HEX')[0].props.onChange({ target: { value: '06' } })
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 수신 길이')[0].props.onChange({ target: { value: '1' } })
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 수신 확인')[0].props.onChange({ target: { value: 'exact' } })
  assert.equal(value.send.hex, '06'); assert.equal(Object.hasOwn(value.receive, 'lengthBytes'), false)
  assert.deepEqual(plain(value.receive), { kind: 'exact', hex: '' })
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 수신 확인')[0].props.onChange({ target: { value: 'fields' } })
  assert.deepEqual(plain(value.receive), { kind: 'fields', messageKey: '', expected: {} })
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 송신 방식')[0].props.onChange({ target: { value: 'message' } })
  assert.deepEqual(plain(value.send), { kind: 'message', messageKey: '', values: {} })
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 송신 방식')[0].props.onChange({ target: { value: 'hex' } })
  assert.deepEqual(plain(value.send), { kind: 'hex', hex: '' })
  assert.match(text(render()), /클라이언트는 송신.*Mock은 수신/)
  walk(render(), node => node.props?.['aria-label'] === '응답 ACK 사용')[0].props.onChange({ target: { checked: false } })
  assert.equal(value, null)
})

test('fixture builder keeps request identity references, requires explicit success and required values, and returns a draft only', () => {
  const { fixtureResponseValues, makeTcpFixture } = load('lib/mockFixture.ts', { './protocolSpec': helpers })
  const wire = spec(), original = JSON.stringify(wire)
  const fields = fixtureResponseValues(wire, 'pay-request', 'pay-response')
  assert.equal(fields.tid, '{{req.tid}}'); assert.equal(fields.code, '{{req.code}}')
  assert.throws(() => makeTcpFixture(wire, 'pay-request', 'pay-response', fields, 'rule', 'success', {}, '', ''), /성공 코드/)
  const draft = makeTcpFixture(wire, 'pay-request', 'pay-response', fields, 'rule', 'success', { tid: 'T001' }, 'status', '00')
  assert.deepEqual(plain(draft), { id: 'rule', when: [{ field: 'code', op: 'eq', value: 'G1' }], then: { mode: 'mock', fields: { code: '{{req.code}}', tid: '{{req.tid}}', status: '00' } } })
  assert.equal(JSON.stringify(wire), original)
  assert.throws(() => makeTcpFixture(wire, 'pay-request', 'pay-response', fields, 'rule', 'strict', {}, '', ''), /필수 응답.*status/)
  const strict = makeTcpFixture(wire, 'pay-request', 'pay-response', { ...fields, status: '00' }, 'rule', 'strict', { tid: 'T001', amount: '18446744073709551615' }, '', '')
  assert.equal(strict.when.find(condition => condition.field === 'amount').value, '18446744073709551615')
  assert.deepEqual(plain(helpers.requestKeys(wire)).map(message => message.key), ['pay-request'])
  assert.equal(helpers.transactionForRule(wire, draft).key, 'payment')
})

test('frontend Mock supports v2 validate, int64 string round trip, raw bytes parse and no matching-rule success', async () => {
  const { protocolPreview, mockPlanPreview, validateProtocol } = await import('../dev/mock-protocol-plans.mjs')
  const wire = spec()
  assert.equal(validateProtocol(wire).valid, true)
  const request = protocolPreview({ spec: wire, transactionKey: 'payment', phase: 'request', values: { tid: 'T001', amount: '18446744073709551615' } })
  assert.equal(request.total, 14); assert.deepEqual(request.errors, [])
  const parsed = protocolPreview({ spec: wire, transactionKey: 'payment', phase: 'request', action: 'parse', bytesB64: request.bytesB64 })
  assert.equal(parsed.fields.find(field => field.name === 'amount').value, '18446744073709551615')
  assert.equal(protocolPreview({ spec: wire, transactionKey: 'payment', phase: 'request', action: 'parse', bytesB64: '*' }).errors[0].path, 'bytesB64')
  const mock = { tcp: { protocolId: 'protocol', rules: [] } }
  const preview = mockPlanPreview({ spec: mock, type: 'TCP', request: { key: 'pay-request', values: { code: 'G1', tid: 'T001', amount: '100' } } }, null, wire)
  assert.equal(preview.sideEffects, false)
  assert.equal(preview.validations[0].code, 'NO_MATCHING_RULE')
  assert.deepEqual(mock.tcp.rules, [], 'preview does not generate rules or mutate a definition')
})

test('frontend API fixture preview does not change request logs or state, including read-only users', async () => {
  const { createMockApi } = await import('../dev/mock-api.mjs'), { createDesktopMock } = await import('../dev/mock-desktop.mjs')
  const api = createDesktopMock(createMockApi)
  const before = api('GET', '/api/v1/mock-servers/demo-tcp-mock/tcp-log')
  const protocol = api('POST', '/api/v1/remote/protocols', { name: 'v2 synthetic', spec: spec() })
  const definition = { tcp: { protocolId: protocol.id, port: 19000, rules: [{ id: 'fixture', when: [{ field: 'code', op: 'eq', value: 'G1' }], then: { mode: 'mock', fields: { code: '{{req.code}}', tid: '{{req.tid}}', status: '00' } } }] } }
  api('PUT', '/__mock/state', { role: 'viewer' })
  const result = api('POST', '/api/v1/mock-servers/preview', { type: 'TCP', spec: definition, request: { key: 'pay-request', values: { code: 'G1', tid: 'T001', amount: '100' } } })
  assert.equal(result.ruleId, 'fixture'); assert.equal(result.transactionKey, 'payment'); assert.equal(result.sideEffects, false)
  assert.deepEqual(api('GET', '/api/v1/mock-servers/demo-tcp-mock/tcp-log'), before)
  assert.throws(() => api('POST', '/api/v1/mock-servers', { name: 'blocked', slug: 'blocked' }), { status: 403 })
})
