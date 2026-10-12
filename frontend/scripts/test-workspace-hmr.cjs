const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
let created = 0
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/app/WorkspaceContext.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText.replaceAll('import.meta.hot', 'hot')
function load(hot) {
  const exported = {}
  vm.runInNewContext(code, { exports: exported, hot, require: name => name === 'react' ? { createContext: () => ({ id: ++created }), useContext: context => ({ context }) } : {} })
  return exported.useWorkspace().context
}
const hot = { data: {} }
const mounted = load(hot)
assert.equal(load(hot), mounted, 'hot replacement retains the Provider context used by existing screens')
assert.equal(load(hot), mounted)
assert.equal(created, 1)
assert.notEqual(load(undefined), mounted, 'production entry creates its normal context without hot state')
console.log('PASS: workspace context identity survives repeated hot replacements while production stays independent')
