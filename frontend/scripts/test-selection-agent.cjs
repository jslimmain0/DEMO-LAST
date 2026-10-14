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

test('MCP vertical layout survives load, import, undo, redo, save and collaboration', () => {
  const legacy = { nodes: [{id:'s',type:'start',x:0,y:0},{id:'a',type:'set',x:264,y:0},{id:'e',type:'end',x:528,y:0}], edges:[{id:'sa',from:'s',to:'a'},{id:'ae',from:'a',to:'e'}] }
  store.setState({readOnly:false})
  store.getState().loadGraph('layout', 'layout', legacy)
  assert.equal(Object.hasOwn(store.getState().getGraph(),'layoutDirection'),false,'legacy graphs retain their existing handles')
  const vertical = {...legacy, name:'new layout', palette:[{id:'new',name:'new',items:[]}], layoutDirection:'TB', nodes:legacy.nodes.map((n,i)=>({...n,x:85,y:i*178}))}
  store.getState().importGraph(vertical)
  assert.equal(store.getState().getGraph().layoutDirection,'TB')
  assert.deepEqual(store.getState().getGraph().edges.map(e=>[e.from,e.to]),[['s','a'],['a','e']])
  store.getState().undo()
  assert.equal(store.getState().layoutDirection,undefined)
  assert.equal(store.getState().flowName,'layout','undoing an import also restores its name')
  assert.equal(store.getState().palette.length,0)
  store.getState().redo()
  assert.equal(store.getState().layoutDirection,'TB')
  assert.equal(store.getState().flowName,'new layout')
  assert.equal(store.getState().palette[0].id,'new')
  store.getState().autoLayout()
  assert.equal(store.getState().layoutDirection,undefined,'horizontal automatic placement also restores horizontal handles')
  store.getState().undo()
  assert.equal(store.getState().layoutDirection,'TB')
  store.getState().applyRemoteGraph(store.getState().nodes,store.getState().edges,'LR')
  assert.equal(store.getState().layoutDirection,undefined)
  store.getState().applyRemoteGraph(store.getState().nodes,store.getState().edges,'TB')
  assert.equal(store.getState().getGraph().layoutDirection,'TB')
})

test('authoring exports public resource intent while preserving imported node destinations and raw data', () => {
  const graph = { name: 'legacy', nodes: [{ id: 'tcp', type: 'tcp', protocolId: 'private-legacy-id', executionAgent: 'local', agentWorkspaceId: 'original-space', agentEnvironment: 'legacy-stage', tcpValues: { value: '{{ TOKEN@env }}' }, customPayload: { nested: ['원본', 4] } }], edges: [], palette: [{ id: 'group', name: 'imported', items: [] }] }
  store.getState().loadGraph('flow', 'legacy', graph)
  const exported = JSON.parse(JSON.stringify(store.getState().getGraph()))
  assert.equal(exported.resourceWorkspaceId, 'public', 'future scheduled/API runs retain the UI shared-resource intent')
  assert.equal(Object.hasOwn(exported, 'envSource'), false, 'a per-run PC source is not frozen into the flow graph')
  assert.equal(Object.hasOwn(graph, 'resourceWorkspaceId'), false, 'loading does not mutate a legacy definition')
  assert.equal(exported.nodes[0].protocolId, 'private-legacy-id', 'an unresolved protocol is not replaced with a shared protocol')
  assert.equal(exported.nodes[0].agentWorkspaceId, 'original-space')
  assert.equal(exported.nodes[0].agentEnvironment, 'legacy-stage')
  assert.deepEqual(exported.nodes[0].customPayload, graph.nodes[0].customPayload)
  store.getState().importGraph(exported)
  const roundTrip = JSON.parse(JSON.stringify(store.getState().getGraph()))
  assert.equal(roundTrip.resourceWorkspaceId, 'public')
  assert.deepEqual(roundTrip.nodes[0], exported.nodes[0])
  assert.deepEqual(roundTrip.palette, exported.palette)
})
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
  const history = store.getState().past
  store.setState({ dirty: false })
  store.getState().updateNodeData('0', { name: '읽기 전용에서 변경 시도' })
  assert.equal(store.getState().dirty, false)
  assert.equal(store.getState().past, history)
  assert.deepEqual(store.getState().nodes, nodes)
})
