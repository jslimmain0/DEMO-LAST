const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const cache = new Map()
function load(file) {
  file = path.resolve(file)
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name + '.ts')) : require(name), module, module.exports)
  return module.exports
}
const { useEditorStore: store } = load(path.join(__dirname, '../src/store/editorStore.ts'))
const { executionAgentPatch } = load(path.join(__dirname, '../src/lib/executionAgentSelection.ts'))
test('mixed selection changes eligible nodes as one undoable action and serializes destination cleanup', () => {
  const data = [
    { id: 'http', type: 'http', executionAgent: 'local', agentWorkspaceId: 'old-space', agentEnvironment: 'old-env' },
    { id: 'tcp', type: 'tcp', executionAgent: 'local', protocolId: 'keep-protocol' },
    { id: 'transform', type: 'transform' },
    { id: 'mock', type: 'http', agentMock: { id: 'legacy' } },
    { id: 'unselected', type: 'set', executionAgent: 'local' },
  ]
  const nodes = data.map((data, i) => ({ id: data.id, type: 'flnode', position: { x: i * 220, y: 0 }, selected: i < 4, data }))
  store.setState({ nodes, edges: [], dirty: false, past: [], future: [], readOnly: false })
  assert.equal(store.getState().setSelectionAgent('server', 'local'), 2)
  assert.equal(store.getState().past.length, 1)
  const changed = store.getState().nodes
  assert.equal(changed[0].data.executionAgent, 'server')
  assert.equal(changed[0].data.agentWorkspaceId, undefined)
  assert.equal(changed[0].data.agentEnvironment, undefined)
  assert.equal(changed[1].data.protocolId, 'keep-protocol')
  assert.equal(changed[2], nodes[2])
  assert.equal(changed[3], nodes[3])
  assert.equal(changed[4], nodes[4])
  assert.deepEqual(changed.map(n => n.selected), nodes.map(n => n.selected))
  assert.equal(JSON.parse(JSON.stringify(store.getState().getGraph())).nodes[0].agentEnvironment, undefined)
  store.getState().undo()
  assert.deepEqual(store.getState().nodes, nodes)
  store.getState().redo()
  assert.deepEqual(store.getState().nodes, changed)
  assert.equal(store.getState().setSelectionAgent('server', 'local'), 0)
  assert.equal(store.getState().past.length, 1)
  store.setState({ readOnly: true })
  assert.equal(store.getState().setSelectionAgent('local', 'local'), 0)
  assert.equal(store.getState().nodes, changed)
})
test('same effective destination preserves overrides; browser HTTP converts to agent execution', () => {
  assert.deepEqual(executionAgentPatch({ type: 'http', agentEnvironment: 'keep' }, 'server', 'server'), { executionAgent: 'server' })
  assert.equal(executionAgentPatch({ type: 'http', executionAgent: 'server', agentEnvironment: 'keep' }, 'server', 'local'), null)
  const patch = executionAgentPatch({ type: 'http', reqMode: 'client', executionAgent: 'server', agentMock: { id: 'legacy' } }, 'server', 'local')
  assert.equal(patch.reqMode, 'server')
  assert.equal(patch.agentMock, undefined)
  for (const type of ['start', 'end', 'wait', 'form', 'input', 'transform', 'switch', 'set', 'if', 'assert', 'note', 'group']) assert.equal(executionAgentPatch({ type }, 'local', 'server'), null)
})
test('selection collapse and deletion preserve unselected nodes and undo restores connections', () => {
  const nodes = ['http', 'note', 'tcp', 'end'].map((type, i) => ({ id: String(i), type: 'flnode', position: { x: i * 220, y: 0 }, selected: i < 2, data: { id: String(i), type } }))
  const edges = [{ id: 'a', source: '0', target: '2' }, { id: 'b', source: '2', target: '3' }]
  store.setState({ nodes, edges, selectedId: '0', dirty: false, past: [], future: [], readOnly: false })
  assert.equal(store.getState().setSelectionCollapsed(true), 1)
  assert.equal(store.getState().nodes[0].data.collapsed, true)
  assert.equal(store.getState().nodes[1], nodes[1])
  assert.equal(store.getState().nodes[2], nodes[2])
  assert.equal(store.getState().setSelectionCollapsed(true), 0)
  assert.equal(store.getState().past.length, 1)
  store.getState().undo()
  assert.deepEqual(store.getState().nodes, nodes)
  assert.equal(store.getState().deleteSelection(), 2)
  assert.deepEqual(store.getState().edges, [edges[1]])
  assert.equal(store.getState().selectedId, null)
  store.getState().undo()
  assert.deepEqual(store.getState().nodes, nodes)
  assert.deepEqual(store.getState().edges, edges)
  store.setState({ readOnly: true })
  assert.equal(store.getState().deleteSelection(), 0)
  assert.equal(store.getState().setSelectionCollapsed(true), 0)
  assert.equal(store.getState().duplicateSelection(), 0)
  assert.equal(store.getState().pasteClipboard(), 0)
  assert.deepEqual(store.getState().nodes, nodes)
})
