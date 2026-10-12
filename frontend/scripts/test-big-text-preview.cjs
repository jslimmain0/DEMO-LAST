// Actual editor/preview callbacks with fake time; input must never wait for preview work.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const jsx = (type, props, key) => ({ type, props, key })
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
let rendering
const react = {
  memo: component => component, lazy: () => 'code-editor', Suspense: 'suspense',
  useState(initial) {
    const i = rendering.index++, slot = rendering.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value }]
  },
  useRef(initial) { return react.useMemo(() => ({ current: initial }), []) },
  useMemo(make, deps) {
    const i = rendering.index++
    if (!rendering.slots[i] || !sameDeps(rendering.slots[i].deps, deps)) rendering.slots[i] = { value: make(), deps }
    return rendering.slots[i].value
  },
  useEffect(effect, deps) {
    const i = rendering.index++, previous = rendering.slots[i]
    if (!previous || !sameDeps(previous.deps, deps)) {
      const slot = rendering.slots[i] = { deps }
      rendering.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() })
    }
  },
}
function renderer(component) {
  const state = { slots: [], index: 0, effects: [] }
  const render = () => {
    rendering = state; state.index = 0; state.effects = []
    const tree = component(); rendering = null
    state.effects.forEach(effect => effect())
    return tree
  }
  render.unmount = () => state.slots.forEach(slot => slot.cleanup?.())
  return render
}
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') {
    if (predicate(node)) result.push(node)
    walk(node.props?.children, predicate, result)
  }
  return result
}
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''
const find = (tree, predicate) => walk(tree, predicate)[0]
let timerId = 0
const timers = new Map()
const calls = { tokens: 0, template: 0, document: 0, json: 0 }
function advancePreview() {
  for (const [id, timer] of [...timers]) if (timer.delay === 300) { timers.delete(id); timer.callback() }
}
function load(file, modules = {}, extra = '') {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, {
    exports, require: name => modules[name] ?? {},
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId }, clearTimeout: id => timers.delete(id),
    localStorage: { getItem: key => key === 'fl:bigedit:preview' ? '1' : null, setItem() {} },
    JSON: { parse: value => { calls.json++; return JSON.parse(value) } },
  })
  return exports
}
const template = load('lib/templatePreview.ts')
const editor = load('components/BigTextEditor.tsx', {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './JsonTree': { JsonTree: 'json-tree' }, './Modal': { Modal: 'modal' }, '../design/ui': { ui: {} },
  '../lib/templatePreview': {
    templateTokens: value => { calls.tokens++; return template.templateTokens(value) },
    renderTemplatePreview: (value, samples) => { calls.template++; return template.renderTemplatePreview(value, samples) },
    previewDocument: value => { calls.document++; return template.previewDocument(value) },
  },
}, '\nexport { PreviewPane };')

let props = { lang: 'html', value: '<p>{{ name@body }}</p>', initialSamples: { 'name@body': '처음' } }
const renderHtml = renderer(() => editor.PreviewPane(props))
let tree = renderHtml(), frame = find(tree, node => node.type === 'iframe')
assert.match(frame.props.srcDoc, /처음/)
assert.equal(frame.props.sandbox.includes('allow-same-origin'), false)
const initialCalls = { ...calls }
for (let i = 0; i < 12; i++) {
  props = { ...props, value: `<p>${i} {{ latest@body }}</p>` }
  tree = renderHtml()
  assert.equal(find(tree, node => node.type === 'iframe'), frame, 'typing retains the committed preview DOM')
}
assert.deepEqual(calls, initialCalls, 'typing does not scan tokens, build srcDoc, render samples or parse JSON')
assert.equal(timers.size, 1, 'rapid input keeps only the latest preview timer')
assert.match(text(tree), /갱신 대기/)
advancePreview(); tree = renderHtml()
assert.equal(calls.tokens, initialCalls.tokens + 1)
assert.equal(calls.template, initialCalls.template + 1)
assert.equal(calls.document, initialCalls.document + 1)
frame = find(tree, node => node.type === 'iframe')
assert.match(frame.props.srcDoc, /11 «latest»/)
const sample = find(tree, node => node.type === 'input' && node.props['aria-label'] === '샘플 latest@body')
sample.props.onChange({ target: { value: '미리보기 샘플' } }); tree = renderHtml()
assert.equal(find(tree, node => node.type === 'iframe'), frame, 'sample typing also retains the committed preview')
assert.equal(props.value, '<p>11 {{ latest@body }}</p>', 'sample substitution must never replace source input')
advancePreview(); tree = renderHtml()
assert.match(find(tree, node => node.type === 'iframe').props.srcDoc, /미리보기 샘플/)
frame = find(tree, node => node.type === 'iframe')
const idleCalls = { ...calls }
renderHtml(); renderHtml()
assert.deepEqual(calls, idleCalls, 'cursor/status or parent rerenders do not rebuild preview work')
find(tree, node => node.type === 'button' && node.props['aria-label'] === '미리보기 다시 시작').props.onClick()
tree = renderHtml()
assert.equal(find(tree, node => node.type === 'iframe'), frame)
advancePreview(); tree = renderHtml()
assert.notEqual(find(tree, node => node.type === 'iframe').key, frame.key, 'explicit refresh restarts even identical HTML')
props = { ...props, value: '<p>닫기 직전</p>' }; renderHtml()
renderHtml.unmount()
assert.equal(timers.size, 0, 'closing cancels outstanding preview work')

let jsonProps = { lang: 'json', value: '{"name":"처음"}', initialSamples: {} }
const renderJson = renderer(() => editor.PreviewPane(jsonProps))
tree = renderJson()
let jsonTree = find(tree, node => node.type === 'json-tree'), jsonCalls = calls.json
for (let i = 0; i < 12; i++) { jsonProps = { ...jsonProps, value: `{"name":"${i}"}` }; tree = renderJson(); assert.equal(find(tree, node => node.type === 'json-tree'), jsonTree) }
assert.equal(calls.json, jsonCalls, 'large JSON trees are not reparsed per keypress')
advancePreview(); tree = renderJson()
assert.equal(calls.json, jsonCalls + 1)
assert.equal(find(tree, node => node.type === 'json-tree').props.value.name, '11')
jsonProps = { ...jsonProps, value: '{' }; renderJson(); advancePreview(); tree = renderJson()
assert.match(text(tree), /JSON 으로 해석할 수 없습니다/)
jsonProps = { ...jsonProps, value: '{"fixed":true}' }; renderJson(); advancePreview(); tree = renderJson()
assert.equal(find(tree, node => node.type === 'json-tree').props.value.fixed, true)
renderJson.unmount()

let raw = '<p>처음</p>', closed
const inputProps = { title: 'HTML 편집', language: 'html', onChange: value => { raw = value }, onClose: () => { closed = raw } }
const renderEditor = renderer(() => editor.BigTextEditor({ ...inputProps, value: raw }))
tree = renderEditor()
find(tree, node => node.type === 'code-editor').props.onChange('<p>최신 {{ name@body }}</p>')
tree = renderEditor()
assert.equal(find(tree, node => node.type === 'code-editor').props.value, raw)
find(tree, node => node.type === 'button' && node.props['aria-label'] === '닫기').props.onClick()
assert.equal(closed, '<p>최신 {{ name@body }}</p>', 'close observes the latest raw input without waiting for preview')
renderEditor.unmount()

let viewerChanges = 0
const renderViewer = renderer(() => editor.BigTextEditor({ title: '읽기 전용 HTML', language: 'html', value: '<p>조회 전용</p>', readOnly: true, onChange: () => { viewerChanges++ }, onClose() {} }))
tree = renderViewer()
const viewerCode = find(tree, node => node.type === 'code-editor')
assert.equal(viewerCode.props.readOnly, true)
viewerCode.props.onChange('바꿀 수 없음')
const viewerFallback = find(tree, node => node.type === 'suspense').props.fallback
assert.equal(viewerFallback.props.readOnly, true)
viewerFallback.props.onChange({ target: { value: '바꿀 수 없음' } })
const formatButton = find(tree, node => node.type === 'button' && text(node) === '⇥ 정렬')
assert.equal(formatButton.props.disabled, true)
formatButton.props.onClick()
assert.equal(viewerChanges, 0, 'viewer fallback, code input and format cannot change authoring source')
assert.equal(find(tree, node => node.type === 'button' && text(node) === '미리보기').props.disabled, false)
assert.match(text(tree), /읽기 전용입니다/)
renderViewer.unmount()

const routeEditor = load('components/MockRouteEditor.tsx', {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../design/ui': { ui: {} },
  './BigTextEditor': { BigTextEditor: 'big-editor', ExpandCorner: 'expand' },
  '../lib/mockSources': load('lib/mockSources.ts'), '../lib/mockCodecOps': load('lib/mockCodecOps.ts'),
}, '\nexport { RuleCard };')
let rule = { id: 'rule', body: '<p>원문</p>', contentType: 'html', callback: { url: '/callback', body: 'id=처음' } }, ruleReadOnly = false
const renderRule = renderer(() => routeEditor.RuleCard({ rule, index: 0, total: 1, route: { path: '/page', rules: [rule] }, sources: [], readOnly: ruleReadOnly, onChange: next => { rule = next } }))
tree = renderRule()
find(tree, node => node.type === 'expand' && node.props.label === '응답 본문 크게 편집').props.onClick()
tree = renderRule()
const originalCollapsed = find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 응답 본문').props.value
for (let i = 0; i < 12; i++) {
  find(tree, node => node.type === 'big-editor').props.onChange(`<p>원문${i} {{ name@body }}</p>`)
  tree = renderRule()
  assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 응답 본문').props.value, originalCollapsed, 'hidden textarea retains its opening value while editing')
  assert.equal(find(tree, node => node.type === 'big-editor').props.value, rule.body, 'the authoring/save source and modal are immediately current')
}
find(tree, node => node.type === 'big-editor').props.onClose(); tree = renderRule()
assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 응답 본문').props.value, rule.body, 'closing applies the entire latest source to the compact textarea')
find(tree, node => node.type === 'expand' && node.props.label === '응답 본문 크게 편집').props.onClick(); tree = renderRule()
assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 응답 본문').props.value, rule.body, 'reopening freezes the current value, never the first opening')
find(tree, node => node.type === 'expand' && node.props.label === '콜백 본문 크게 편집').props.onClick(); tree = renderRule()
assert.equal(find(tree, node => node.type === 'big-editor').props.value, 'id=처음', 'switching edit targets captures the matching field')
find(tree, node => node.type === 'big-editor').props.onChange('id=최신&name={{ name@body }}'); tree = renderRule()
assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 콜백 본문').props.value, 'id=처음')
assert.equal(rule.callback.body, 'id=최신&name={{ name@body }}')
assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 응답 본문').props.value, rule.body, 'the other field remains synchronized')
find(tree, node => node.type === 'big-editor').props.onClose(); tree = renderRule()
assert.equal(find(tree, node => node.type === 'textarea' && node.props['aria-label'] === '규칙 1 콜백 본문').props.value, rule.callback.body)
ruleReadOnly = true; tree = renderRule()
find(tree, node => node.type === 'expand' && node.props.label === '응답 본문 크게 편집').props.onClick(); tree = renderRule()
assert.equal(find(tree, node => node.type === 'big-editor').props.readOnly, true)
find(tree, node => node.type === 'expand' && node.props.label === '콜백 본문 크게 편집').props.onClick(); tree = renderRule()
assert.equal(find(tree, node => node.type === 'big-editor').props.readOnly, true)
renderRule.unmount()
rule = { id: 'new-rule', body: '새 규칙 본문', contentType: 'html' }
const remountedRule = renderer(() => routeEditor.RuleCard({ rule, index: 0, total: 1, route: { path: '/page', rules: [rule] }, sources: [] }))
tree = remountedRule()
assert.equal(find(tree, node => node.type === 'big-editor'), undefined, 'remount does not retain another rule modal')
find(tree, node => node.type === 'expand').props.onClick(); tree = remountedRule()
assert.equal(find(tree, node => node.type === 'big-editor').props.value, rule.body, 'a new rule opens with its own current source')
remountedRule.unmount()
const propertyPanel = fs.readFileSync(path.join(__dirname, '../src/panels/PropertyPanel.tsx'), 'utf8')
const propertyCallers = [...propertyPanel.matchAll(/<BigTextEditor\b([\s\S]*?)\n\s*\/>/g)]
assert.equal(propertyCallers.length, 2)
assert.ok(propertyCallers.every(match => /readOnly=\{!canEdit\}/.test(match[1])), 'workflow raw/callback editors inherit the existing edit permission')
console.log('PASS: preview work commits once after typing, keeps JSON/iframe stable, samples stay separate, close keeps latest input')
console.log('PASS: expanded body/callback keeps hidden textarea stable while authoring stays current; close/reopen/target-switch/remount use exact latest source')
console.log('PASS: viewer code/fallback/format are read-only, sample preview remains available, all callers propagate existing permissions')
