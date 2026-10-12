const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
let cursor = 0, effects = [], view, observer, frameId = 0, reads = 0, theme = 'dark'
const hooks = [], frames = new Map(), emitted = [], statuses = [], ref = { current: null }
const facet = name => ({ of: value => ({ name, value }) })
const doc = text => ({ length: text.length, lines: text.split('\n').length, toString() { reads++; return text }, lineAt: head => ({ number: text.slice(0, head).split('\n').length, from: text.lastIndexOf('\n', Math.max(0, head - 1)) + 1 }), line: number => { const lines = text.split('\n'); const from = lines.slice(0, number - 1).reduce((n, line) => n + line.length + 1, 0); return { from, to: from + lines[number - 1].length } } })
const selection = head => ({ main: { head, from: head, to: head } })
class Compartment { of(value) { return { compartment: this, value } } reconfigure(value) { return { compartment: this, value } } }
class EditorView {
  static updateListener = facet('listener')
  static lineWrapping = 'wrap'
  static editable = facet('editable')
  static contentAttributes = facet('attributes')
  static theme = value => value
  constructor(config) {
    view = this; this.config = config; this.dispatches = []
    this.listener = config.extensions.find(extension => extension.name === 'listener').value
    this.state = { doc: doc(config.doc), selection: selection(0), readOnly: false, replaceSelection: text => ({ changes: { from: 0, to: this.state.doc.length, insert: text } }) }
  }
  dispatch(transaction) {
    this.dispatches.push(transaction)
    if (transaction.effects) for (const extension of [transaction.effects.value].flat()) if (extension?.name === 'readOnly') this.state.readOnly = extension.value
    if (transaction.changes) {
      const text = transaction.changes.insert; this.state.doc = doc(text); this.state.selection = selection(text.length)
      this.listener({ state: this.state, docChanged: true, selectionSet: true })
    }
  }
  focus() {}
  destroy() { this.destroyed = true }
}
const react = {
  forwardRef: component => component,
  useRef(value) { const index = cursor++; return hooks[index] ??= { current: value } },
  useImperativeHandle(target, make) { target.current = make() },
  useEffect(effect, deps) { const index = cursor++; const previous = hooks[index]; if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) effects.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() } }) },
}
const exportsObject = {}
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/components/CodeEditor.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
vm.runInNewContext(code, {
  exports: exportsObject,
  document: { documentElement: { getAttribute: () => theme } },
  MutationObserver: class { constructor(callback) { observer = this; this.callback = callback } observe() {} disconnect() { this.disconnected = true } },
  requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId }, cancelAnimationFrame: id => frames.delete(id),
  require: name => ({
    react, 'react/jsx-runtime': { jsx: (type, props) => { if (props.ref) props.ref.current = {}; return { type, props } } },
    codemirror: { EditorView, basicSetup: [] }, '@codemirror/state': { Compartment, EditorState: { readOnly: facet('readOnly'), languageData: facet('languageData') } },
    '@codemirror/view': { keymap: facet('keymap'), placeholder: value => value }, '@codemirror/commands': { indentWithTab: {} },
    '@codemirror/lang-html': { html: () => [] }, '@codemirror/lang-json': { json: () => [], jsonParseLinter: () => [] }, '@codemirror/lang-javascript': { javascript: () => [] }, '@codemirror/lang-xml': { xml: () => [] },
    '@codemirror/language': { syntaxTree: () => ({ cursor: () => ({ type: { isError: false }, next: () => false }) }) },
    '@codemirror/lint': { linter: source => source, lintGutter: () => [], setDiagnostics: (state, diagnostics) => ({ diagnostics }) },
    '@codemirror/theme-one-dark': { oneDark: 'dark-theme' }, 'js-beautify': {}, '../lib/codeFormat': {},
  })[name] ?? {},
})
function render(value, options = {}) {
  cursor = 0; effects = []
  exportsObject.default({ value, onChange: text => emitted.push(text), language: 'javascript', onStatus: status => statuses.push(status), ...options }, ref)
  effects.forEach(effect => effect())
}
render('initial')
assert.equal(statuses.length, 1)
view.dispatch({ changes: { from: 0, to: 7, insert: '입력' } })
view.dispatch({ changes: { from: 0, to: 2, insert: '입력 완료' } })
assert.deepEqual(emitted, ['입력', '입력 완료'], 'document edits reach the caller immediately')
assert.equal(frames.size, 1, 'cursor reports are batched without delaying source changes')
const previousReads = reads, previousDispatches = view.dispatches.length
render('입력 완료')
assert.equal(reads, previousReads, 'controlled echoes do not flatten the document again')
assert.equal(view.dispatches.length, previousDispatches, 'controlled echoes preserve caret and undo')
for (const [id, callback] of frames) { frames.delete(id); callback() }
assert.equal(statuses.at(-1).col, 6, 'status uses the latest selection')
render('preset', { readOnly: true, ariaLabel: '플러그인 코드', diagnostics: [{ line: 1, col: 100, message: 'EOF' }] })
assert.equal(view.state.doc.toString(), 'preset', 'external presets still replace the document')
assert.equal(emitted.length, 2, 'loading another document does not report a user edit or mark it dirty')
assert.equal(view.state.readOnly, true)
assert.equal(ref.current.format(), 'fail')
const beforeInsert = emitted.length
ref.current.insert('blocked'); assert.equal(emitted.length, beforeInsert)
const diagnostics = view.dispatches.findLast(transaction => transaction.diagnostics)?.diagnostics
assert.equal(diagnostics[0].to, view.state.doc.length, 'EOF diagnostics stay in bounds')
theme = 'light'; observer.callback()
assert.equal(view.dispatches.at(-1).effects.value.length, 0, 'theme changes reconfigure the current editor')
for (const hook of hooks) hook?.cleanup?.()
assert.equal(frames.size, 0)
assert.equal(observer.disconnected, true)
console.log('PASS: actual CodeEditor preserves immediate edits, avoids echo serialization, batches status, applies read-only/theme and bounded diagnostics')
