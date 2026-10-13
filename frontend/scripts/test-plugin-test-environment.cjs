const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const meta = { id: 'test-plugin', kind: 'transform', inputs: [], params: [] }
let active = '개발', connected = true, status = 'ready', failPreparation = false, stateIndex = 0, runError
let previousResult = null, deferredReply = null
const events = [], sent = [], effects = []
const listeners = new Map()
const timers = [], writes = []
const jsx = (type, props) => ({ type, props })
const exported = {}
const apiError = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/apiError.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: apiError })
const environment = { setActiveEnv: value => { active = value }, prepareForRun: async () => { events.push('prepare'); if (failPreparation) throw new Error('환경 저장 실패') }, ensureEnvLoaded: async () => {} }
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/PluginRunPanel.tsx'), 'utf8') + '\nexports.request = pluginTryRequest;', { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
vm.runInNewContext(code, { exports: exported, structuredClone, TextEncoder, btoa, atob, setTimeout: (callback, delay) => { const timer = { callback, delay, active: true }; timers.push(timer); return timer }, clearTimeout: timer => { timer.active = false }, localStorage: { getItem: () => null, setItem: (key, value) => writes.push({ key, value }) }, window: { addEventListener: (type, handler, capture) => listeners.set(type, { handler, capture }), removeEventListener() {} }, require: name => ({
  react: { memo: component => component, useCallback: callback => callback, useRef: value => ({ current: value }), useEffect: effect => effects.push(effect), useState: initial => {
    const index = stateIndex++
    return [index === 0 ? meta : index === 3 ? previousResult : typeof initial === 'function' ? initial() : initial, value => { if (index === 4) runError = value; if (index === 3) previousResult = value }]
  } },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '../app/WorkspaceContext': { useWorkspace: () => ({ remoteKey: 'company:alice:true', connected }), useCentralApi: () => ({ pluginsApi: { tryRun: async request => { events.push('try'); sent.push(request); return deferredReply ?? { meta, outputs: { ok: true }, logs: [], durationMs: 1 } } } }) },
  '../lib/environments': { useEnvStore: source => { assert.equal(source, 'server'); return { active, envs: { 개발: {}, 운영: {} } } }, useEnvironment: source => { assert.equal(source, 'server'); return environment }, useEnvironmentLoadStatus: source => { assert.equal(source, 'server'); return status } },
  '../lib/vaultSources': { useVaultSources: () => [] }, '../design/ui': { ui: {} },
  '../lib/apiError': apiError,
})[name] ?? {} })
function walk(node, predicate, out = []) { if (Array.isArray(node)) node.forEach(child => walk(child, predicate, out)); else if (node && typeof node === 'object') { if (predicate(node)) out.push(node); walk(node.props?.children, predicate, out) } return out }
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
function render(canRun = true, extra = {}) { stateIndex = 0; return exported.PluginRunPanel({ source: 'source', scriptId: null, canRun, onDiagnostics() {}, ...extra }) }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function run() {
  let tree = render()
  let select = walk(tree, node => node.type === 'select' && node.props['aria-label'] === '테스트 환경 · 서버')[0]
  assert.equal(select.props.value, '개발')
  assert.match(text(tree), /서버 · 개발/)
  select.props.onChange({ target: { value: '운영' } }); tree = render()
  const button = walk(tree, node => node.type === 'button' && node.props.title === 'Ctrl+Enter')[0]
  button.props.onClick(); await tick()
  assert.deepEqual(events, ['prepare', 'try'])
  assert.equal(sent[0].environment, '운영')
  failPreparation = true; tree = render(); events.length = 0
  walk(tree, node => node.type === 'button' && node.props.title === 'Ctrl+Enter')[0].props.onClick(); await tick()
  assert.deepEqual(events, ['prepare'])
  assert.equal(sent.length, 1, 'failed environment save sends no plugin request')
  assert.equal(previousResult, null, 'failed preparation cannot keep an old success result on screen')
  assert.match(runError, /환경 저장 실패/)
  connected = false; tree = render()
  assert.equal(walk(tree, node => node.type === 'select' && node.props['aria-label'] === '테스트 환경 · 서버')[0].props.disabled, true)
  assert.equal(walk(tree, node => node.type === 'button' && node.props.title === 'Ctrl+Enter')[0].props.disabled, true)
  connected = true; status = 'loading'; tree = render()
  assert.equal(walk(tree, node => node.type === 'select' && node.props['aria-label'] === '테스트 환경 · 서버')[0].props.disabled, true)
  status = 'ready'; tree = render(false)
  assert.equal(walk(tree, node => node.type === 'select' && node.props['aria-label'] === '테스트 환경 · 서버')[0].props.disabled, true)
  failPreparation = false; let opened = 0
  tree = render(true, { getSource: () => 'latest-source', active: false, onRunStart: () => opened++ })
  const before = sent.length
  walk(tree, node => node.type === 'button' && node.props.title === 'Ctrl+Enter')[0].props.onClick(); await tick()
  assert.equal(opened, 1, 'testing opens the code support panel even when initially closed')
  assert.equal(sent.length, before + 2, 'fresh source metadata compiles before the actual test')
  assert.equal(sent.at(-1).source, 'latest-source', 'testing reads synchronous source ref rather than deferred metadata props')
  assert.equal(sent.at(-1).environment, '운영')
  const sample = { inputs: {}, config: {}, value: '', fn: 'encode', direction: 'send', message: '{}', bytesText: '', bytesMode: 'text' }
  assert.throws(() => exported.request({ ...meta, kind: 'fieldCodec' }, { ...sample, message: '{wrong' }, 'source'), /JSON/)
  assert.throws(() => exported.request({ ...meta, kind: 'fieldCodec' }, { ...sample, message: '[]' }, 'source'), /JSON/)
  assert.throws(() => exported.request({ ...meta, kind: 'messageCodec' }, { ...sample, bytesMode: 'hex', bytesText: '0ff' }, 'source'), /hex/)
  const large = exported.request({ ...meta, kind: 'messageCodec' }, { ...sample, bytesText: 'x'.repeat(300000) }, 'source')
  assert.equal(atob(large.bytesB64).length, 300000, 'large byte bodies avoid argument-spread overflow')
  let currentSource = 'source', resolve, reject
  deferredReply = new Promise((success, failure) => { resolve = success; reject = failure })
  const diagnostics = []
  tree = render(true, { getSource: () => currentSource, onDiagnostics: value => diagnostics.push(value) })
  walk(tree, node => node.type === 'button' && node.props.title === 'Ctrl+Enter')[0].props.onClick(); await tick()
  currentSource = 'source-B'
  reject({ response: { data: { message: 'old-source-error', line: 3, col: 1 } } }); await tick()
  assert.equal(diagnostics.length, 0, 'late old-source errors cannot decorate newer code')
  assert.match(runError, /현재 내용으로 다시 테스트/)
  deferredReply = new Promise(success => { resolve = success })
  currentSource = 'source'; tree = render(true, { getSource: () => currentSource })
  walk(tree, node => node.type === 'button' && node.props.title === 'Ctrl+Enter')[0].props.onClick(); await tick()
  currentSource = 'source-C'
  resolve({ meta, outputs: { old: true }, logs: [], durationMs: 1 }); await tick()
  assert.equal(previousResult, null, 'late old-source success cannot masquerade as current test output')
  deferredReply = null
  effects.length = 0; currentSource = 'source'; tree = render(true, { getSource: () => currentSource })
  effects.find(effect => String(effect).includes("addEventListener('keydown'"))()
  const shortcut = listeners.get('keydown')
  assert.equal(shortcut.capture, true, 'plugin shortcut intercepts CodeMirror before its blank-line key binding')
  let prevented = 0, stopped = 0
  const event = { ctrlKey: true, key: 'Enter', target: { closest: selector => selector === '.fl-plugin-workbench' ? {} : null }, preventDefault: () => prevented++, stopPropagation: () => stopped++ }
  const shortcutBefore = sent.length
  shortcut.handler({ ...event, isComposing: true }); await tick()
  assert.equal(sent.length, shortcutBefore, 'IME composition never triggers testing')
  shortcut.handler({ ...event, target: { closest: () => null } }); await tick()
  assert.equal(sent.length, shortcutBefore, 'shortcut is scoped to plugin workbench')
  shortcut.handler(event); await tick()
  assert.equal(prevented, 1); assert.equal(stopped, 1)
  assert.equal(sent.at(-1).source, 'source', 'Ctrl+Enter sends exact source without an inserted blank line')
  meta.inputs = [{ key: 'text', label: '테스트 입력' }]
  const ordered = walk(render(), () => true)
  assert.ok(ordered.findIndex(node => node.props?.ariaLabel === '입력 text') < ordered.findIndex(node => node.type === 'button' && node.props.title === 'Ctrl+Enter'), 'actual execution belongs after test inputs')
  assert.equal(text(ordered.find(node => node.type === 'button' && node.props.title === 'Ctrl+Enter')), '테스트 실행')
  effects.length = 0; tree = render()
  const samplePersistence = effects.find(effect => String(effect).includes('const timer') && String(effect).includes('JSON.stringify(sampleRef.current)'))
  const cancelSave = samplePersistence()
  const sampleInput = walk(tree, node => node.props?.ariaLabel === '입력 text')[0]
  sampleInput.props.onChange('첫째'); sampleInput.props.onChange('둘째'); sampleInput.props.onChange('마지막')
  assert.equal(writes.length, 0, 'typing does not serialize/write localStorage on every input')
  const pendingSave = timers.at(-1)
  assert.equal(pendingSave.delay, 600)
  pendingSave.callback()
  assert.equal(writes.length, 1)
  assert.equal(JSON.parse(writes[0].value).inputs.text, '마지막')
  cancelSave(); assert.equal(pendingSave.active, false)
  effects.find(effect => String(effect).includes("addEventListener('beforeunload'"))()
  sampleInput.props.onChange('떠나기 직전')
  listeners.get('beforeunload').handler()
  assert.equal(JSON.parse(writes.at(-1).value).inputs.text, '떠나기 직전', 'page exit flushes the latest sample without waiting for the debounce')
  console.log('PASS: actual plugin test panel selects server environment, prepares saved values before request, blocks failed save/offline/loading/read-only')
  console.log('PASS: latest source compiles/tests from closed panel; invalid JSON/hex reject; large bodies encode safely at run time')
  console.log('PASS: late code success/error are invalidated; captured workbench shortcut preserves exact source and respects IME')
  console.log('PASS: sample persistence batches keystrokes and flushes the latest input on page exit')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
