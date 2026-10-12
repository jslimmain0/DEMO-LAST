const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const values = [], submitted = [], focused = [], exported = {}
let index = 0, cancelled = 0
const jsx = (type, props) => ({ type, props })
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/InputPromptDialog.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
  exports: exported, document: { getElementById: id => ({ focus: () => focused.push(id) }) },
  require: name => ({ react: { useState(initial) { const slot = index++; if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], update => { values[slot] = typeof update === 'function' ? update(values[slot]) : update }] } }, 'react/jsx-runtime': { jsx, jsxs: jsx }, './Modal': { Modal: 'modal' }, '../design/ui': { ui: {} } })[name] ?? {},
})
function walk(node, predicate, out = []) { if (Array.isArray(node)) node.forEach(child => walk(child, predicate, out)); else if (node && typeof node === 'object') { if (predicate(node)) out.push(node); walk(node.props?.children, predicate, out) } return out }
const input = { nodeId: 'input', nodeName: '주문 입력', fields: [{ key: 'name', label: '이름', type: 'string' }, { key: 'amount', label: '금액', type: 'number' }, { key: 'extra', label: '상세', type: 'json' }] }
const render = () => { index = 0; return exported.InputPromptDialog({ input, onConfirm: value => submitted.push(value), onCancel: () => cancelled++ }) }
let tree = render()
function edit(id, value) { walk(tree, node => node.props?.id === `fl-input-${id}`)[0].props.onChange({ target: { value } }); tree = render() }
edit('name', '한글 입력'); edit('amount', '123'); edit('extra', '{"ok":true}')
let prevented = 0
const key = (tagName, options = {}) => ({ key: 'Enter', target: { tagName }, nativeEvent: {}, preventDefault: () => prevented++, ...options })
tree.props.onKeyDown(key('INPUT', { nativeEvent: { isComposing: true } }))
tree.props.onKeyDown(key('INPUT', { keyCode: 229 }))
tree.props.onKeyDown(key('BUTTON')); tree.props.onKeyDown(key('SELECT')); tree.props.onKeyDown(key('TEXTAREA'))
assert.equal(submitted.length, 0)
assert.equal(prevented, 0, 'IME, native buttons/selects and JSON newlines retain their own keyboard behavior')
tree.props.onKeyDown(key('INPUT'))
assert.equal(submitted[0].name, '한글 입력'); assert.equal(submitted[0].amount, 123); assert.equal(submitted[0].extra.ok, true)
tree.props.onKeyDown(key('TEXTAREA', { ctrlKey: true })); assert.equal(submitted.length, 2)
edit('amount', '')
tree.props.onKeyDown(key('INPUT')); tree = render()
assert.equal(submitted.length, 2); assert.equal(focused.at(-1), 'fl-input-amount')
assert.equal(walk(tree, node => node.props?.role === 'alert').length, 1)
edit('amount', '456'); edit('extra', '{')
tree.props.onKeyDown(key('TEXTAREA', { ctrlKey: true })); tree = render()
assert.equal(focused.at(-1), 'fl-input-extra'); assert.equal(submitted.length, 2)
walk(tree, node => node.type === 'button' && node.props.children === '취소')[0].props.onClick()
assert.equal(cancelled, 1)
console.log('PASS: input prompt preserves IME and native controls, submits typed values, supports JSON Ctrl+Enter, focuses invalid fields and permits cancellation')
