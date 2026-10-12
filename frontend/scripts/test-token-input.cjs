// Actual TokenInput/KeyValueEditor events; DOM reads and IME commits are counted without a browser.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
let rendering, layoutReads = 0, rebuilds = 0, frameId = 0
const frames = new Map()
class TextNode { constructor(value) { this.nodeType = 3; this.nodeValue = value; this.parent = null } get textContent() { return this.nodeValue } }
class Element {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.dataset = {}; this.style = {}; this.events = {} }
  get firstChild() { return this.childNodes[0] }
  get lastChild() { return this.childNodes.at(-1) }
  get scrollWidth() { layoutReads++; return 160 }
  get clientWidth() { layoutReads++; return 100 }
  get textContent() { return this.childNodes.map(node => node.textContent).join('') }
  set textContent(value) { rebuilds++; this.childNodes = []; if (value) this.appendChild(new TextNode(value)) }
  appendChild(node) { node.parent = this; this.childNodes.push(node); return node }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)) }
  insertBefore(node, next) { node.parent = this; this.childNodes.splice(this.childNodes.indexOf(next), 0, node) }
  contains(node) { return this === node || this.childNodes.some(child => child === node || child.contains?.(node)) }
  setAttribute() {}
  addEventListener(name, handler) { this.events[name] = handler }
  remove() { if (this.parent) this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1) }
  focus() {}
}
let selection = null
const document = { createElement: tag => new Element(tag), createTextNode: value => new TextNode(value) }
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
const react = {
  useState(initial) { const i = rendering.index++; const slot = rendering.slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }] },
  useRef(initial) { return react.useMemo(() => ({ current: initial }), []) },
  useMemo(make, deps) { const i = rendering.index++; if (!rendering.slots[i] || !sameDeps(rendering.slots[i].deps, deps)) rendering.slots[i] = { value: make(), deps }; return rendering.slots[i].value },
  useEffect(effect, deps) { const i = rendering.index++, previous = rendering.slots[i]; if (!previous || !sameDeps(previous.deps, deps)) { const slot = rendering.slots[i] = { deps }; rendering.effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() }) } },
}
const jsx = (type, props) => ({ type, props })
const modules = {
  react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../components/icons': { DataInsertIcon: 'icon' },
  '../canvas/graphAdapter': { asGraphNode: value => value }, '../canvas/nodeMeta': { catColor: () => '#333', typeIcon: () => 'node' },
  '../store/editorStore': { useEditorStore: { getState: () => ({ nodes: [] }) } }, './BindingPicker': { BindingPicker: 'picker' },
  '../binding/BindingChip': { BindingChip: 'chip' }, '../components/Modal': { Modal: 'modal' }, '../lib/ids': { newId: () => 'new-row' }, '../design/ui': { ui: {} }, './field-layout.css': {},
}
function load(file) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, {
    exports: exported, require: name => { if (!(name in modules)) throw new Error(`Missing fixture: ${name}`); return modules[name] },
    HTMLElement: Element, Node: { TEXT_NODE: 3 }, document, window: { getSelection: () => selection },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id }, cancelAnimationFrame: id => frames.delete(id),
  })
  return exported
}
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') { if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result) }
  return result
}
function renderer(component) {
  const state = { slots: [], index: 0, effects: [] }
  return { render() {
    rendering = state; state.index = 0; state.effects = []
    const tree = component()
    const input = walk(tree, node => node.props?.role === 'textbox' && node.props?.ref)[0]
    if (input && !input.props.ref.current) input.props.ref.current = new Element('div')
    rendering = null; state.effects.forEach(effect => effect())
    return { tree, input, root: input?.props.ref.current }
  }, unmount() { state.slots.forEach(slot => slot?.cleanup?.()) } }
}
function flushFrames() { for (const [id, callback] of [...frames]) { frames.delete(id); callback() } }
modules['../lib/tokenGrammar'] = load('lib/tokenGrammar.ts')
const { TokenInput } = modules['../binding/TokenInput'] = load('binding/TokenInput.tsx')
modules['../lib/bulkPaste'] = load('lib/bulkPaste.ts')
const { KeyValueEditor } = load('panels/KeyValueEditor.tsx')

let value = '시작', emitted = []
const editor = renderer(() => TokenInput({ value, placeholder: '값 안내', onChange: next => { value = next; emitted.push(next) }, sources: [] }))
let view = editor.render()
flushFrames(); layoutReads = 0; rebuilds = 0
const textNode = view.root.firstChild
const range = { startContainer: textNode, cloneRange() { return this } }
selection = { rangeCount: 1, getRangeAt: () => range }
for (const text of ['시작a', '시작ab', '시작abc']) {
  textNode.nodeValue = text; view.input.props.onInput(); view = editor.render()
  assert.equal(view.root.firstChild, textNode, 'parent echoes must preserve the text node and caret range')
  assert.equal(selection.getRangeAt(0), range)
}
assert.equal(layoutReads, 0, 'typing must not synchronously read scrollWidth/clientWidth')
assert.equal(frames.size, 1, 'multiple input events share one overflow measurement')
assert.equal(rebuilds, 0)
flushFrames(); assert.equal(layoutReads, 2)
assert.deepEqual(emitted, ['시작a', '시작ab', '시작abc'])
view.input.props.onInput(); assert.equal(emitted.length, 3, 'duplicate browser input events do not re-emit unchanged values')

emitted = []; view.input.props.onCompositionStart()
for (const text of ['ㅎ', '하', '한글']) { textNode.nodeValue = text; view.input.props.onInput(); view.input.props.onKeyUp() }
let prevented = 0
view.input.props.onKeyDown({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true }, preventDefault: () => prevented++ })
assert.equal(prevented, 0, 'IME confirmation Enter must remain available to the browser')
assert.equal(emitted.length, 0, 'IME intermediate syllables do not trigger parent graph updates')
value = 'external old value'; view = editor.render()
assert.equal(view.root.firstChild, textNode, 'external values must not replace the composing DOM')
view.input.props.onCompositionEnd(); view.input.props.onInput(); view = editor.render()
assert.deepEqual(emitted, ['한글'])
assert.equal(view.root.firstChild, textNode)
view.input.props.onKeyDown({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false }, preventDefault: () => prevented++ })
assert.equal(prevented, 1, 'ordinary Enter keeps the single-line contract')

selection = null
view.input.props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '{{ 주문번호@body }}\n끝' } })
assert.equal(value, '한글{{ 주문번호@body }} 끝', 'plain-text paste preserves Unicode token syntax and flattens newlines')
const chip = view.root.childNodes.find(node => node.dataset?.token)
assert.equal(chip.dataset.token, '{{ 주문번호@body }}')
let clipboard
selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ commonAncestorContainer: view.root, cloneContents: () => { const holder = new Element('div'); holder.append(...view.root.childNodes); return holder }, deleteContents: () => { view.root.textContent = '' } }) }
view.input.props.onCopy({ preventDefault() {}, clipboardData: { setData: (_type, text) => { clipboard = text } } })
assert.equal(clipboard, '한글{{ 주문번호@body }} 끝', 'copy uses raw tokens, never the rendered chip label')
view.input.props.onCut({ preventDefault() {}, clipboardData: { setData: (_type, text) => { clipboard = text } } })
assert.equal(value, '')
assert.equal(clipboard, '한글{{ 주문번호@body }} 끝')
view = editor.render()
view.input.props.onCompositionStart(); view = editor.render()
assert.equal(walk(view.tree, node => node.type === 'span' && node.props.children === '값 안내').length, 0, 'placeholder hides while composing an initially empty field')
view.input.props.onCompositionEnd(); view = editor.render()
assert.equal(walk(view.tree, node => node.type === 'span' && node.props.children === '값 안내').length, 1, 'cancelling an empty composition restores the placeholder')
assert.ok(frames.size)
editor.unmount(); assert.equal(frames.size, 0, 'unmount cancels deferred DOM measurement')

const rowChanges = [], rows = [{ id: 'row', key: '한글키', value: '값' }]
const fields = renderer(() => KeyValueEditor({ rows, sources: [], onChange: next => rowChanges.push(next) }))
const key = walk(fields.render().tree, node => node.props?.['data-field-key'] === 'row')[0]
key.props.onKeyDown({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true }, preventDefault() {} })
assert.equal(rowChanges.length, 0, 'IME key confirmation must not append a field')
key.props.onKeyDown({ key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false }, preventDefault() {} })
assert.equal(rowChanges[0].length, 2)
assert.equal(rowChanges[0][0], rows[0])
console.log('PASS: token typing batches layout reads, preserves caret DOM, commits IME once and skips echo/duplicate updates')
console.log('PASS: Unicode token paste/copy/cut remain exact; pending measurement cleans up; field Enter respects IME')

let readonlyChanges = 0
const readonly = renderer(() => TokenInput({ value: '읽기 전용{{ 주문번호@body }}', onChange: () => readonlyChanges++, sources: [], readOnly: true }))
const readView = readonly.render()
assert.equal(readView.input.props.contentEditable, false)
assert.equal(readView.input.props['aria-readonly'], true)
assert.equal(walk(readView.tree, node => node.props?.['aria-label'] === '데이터 삽입')[0].props.disabled, true)
const originalReadonlyValue = readView.root.childNodes.map(node => node.nodeValue ?? node.dataset?.token ?? '').join('')
readView.input.props.onInput()
readView.input.props.onPaste({ preventDefault() {}, clipboardData: { getData: () => '수정 시도' } })
selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ commonAncestorContainer: readView.root, cloneContents: () => { const holder = new Element('div'); holder.append(...readView.root.childNodes); return holder }, deleteContents: () => { throw new Error('readonly cut deleted content') } }) }
readView.input.props.onCut({ preventDefault() {}, clipboardData: { setData: (_type, text) => { clipboard = text } } })
assert.equal(clipboard, '읽기 전용{{ 주문번호@body }}')
let clicksBlocked = 0
readView.input.props.onClickCapture({ target: { closest: () => ({}) }, preventDefault: () => clicksBlocked++, stopPropagation: () => clicksBlocked++ })
assert.equal(clicksBlocked, 2, 'readonly chips cannot remove themselves through their native click listener')
assert.equal(readView.root.childNodes.map(node => node.nodeValue ?? node.dataset?.token ?? '').join(''), originalReadonlyValue)
assert.equal(readonlyChanges, 0)
readonly.unmount()
console.log('PASS: readonly token fields preserve selection/copy while blocking input, paste, cut, token removal and insertion')
