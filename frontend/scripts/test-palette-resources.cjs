// Actual Palette rendering and add handlers; no browser, backend or MCP calls.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
let mockMode = true, origin = 'local', workspaceCalls = 0
const additions = [], templates = []
const template = { id: 'saved-transform', type: 'transform', transformId: 'shared-mask', config: { keep: 4 } }
const store = {
  nodes: [], palette: [{ id: 'imported', title: '가져온 노드', items: [{ id: 'transform-template', label: '재사용 변환', node: template }, { id: 'http-template', label: '재사용 HTTP', node: { id: 'http', type: 'http' } }] }],
  addNode: (type, position) => additions.push({ type, position }), addNodeFromTemplate: (node, position) => templates.push({ node, position }),
  removePaletteGroup() {}, removePaletteItem() {},
}
const useEditorStore = select => select(store)
useEditorStore.getState = () => store
const jsx = (type, props) => ({ type, props })
const modules = {
  react: { useMemo: make => make(), useRef: initial => ({ current: initial }), useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] },
  'react/jsx-runtime': { jsx, jsxs: jsx },
  '@xyflow/react': { useReactFlow: () => ({ screenToFlowPosition: point => point, setCenter() {}, getZoom: () => 1, fitBounds() {} }) },
  '../store/editorStore': { useEditorStore }, '../app/WorkspaceContext': { useWorkspace: () => { workspaceCalls++; return { current: { origin } } } },
  '../lib/frontendMock': { get FRONTEND_MOCK() { return mockMode } }, '../lib/ids': { newId: () => 'new-node' },
  '../components/MethodTag': { MethodTag: 'method' }, '../components/AppIcon': { NodeTypeIcon: 'node-icon', AppIcon: 'icon' },
  './nodeMeta': { NODE_W: 276, TERMINAL_W: 85 }, './nodePlacement': {}, './node-visuals.css': {},
}
function load(file) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, window: { innerWidth: 1200, innerHeight: 800 }, require: name => { if (!(name in modules)) throw new Error(`Missing fixture: ${name}`); return modules[name] } })
  return exported
}
modules['./nodeFactory'] = load('canvas/nodeFactory.ts')
const { Palette } = load('canvas/Palette.tsx')
function walk(node, predicate, result = []) {
  if (Array.isArray(node)) node.forEach(child => walk(child, predicate, result))
  else if (node && typeof node === 'object') { if (predicate(node)) result.push(node); walk(node.props?.children, predicate, result) }
  return result
}
for (const [mock, location, visible] of [[true, 'local', true], [false, 'local', true], [false, 'server', true]]) {
  mockMode = mock; origin = location
  const before = workspaceCalls, tree = Palette({})
  assert.equal(workspaceCalls, before + 1, 'Workspace hook must run even in Mock mode')
  const transform = walk(tree, node => node.type === 'button' && node.props.title === '데이터 변환 추가 (클릭 또는 드래그)')[0]
  const imported = walk(tree, node => node.props?.role === 'button' && node.props.title === '재사용 변환 추가 (클릭 또는 드래그)')[0]
  assert.equal(!!transform, visible, `${location} ${mock ? 'Mock' : 'production'}: built-in transform gate`)
  assert.equal(!!imported, visible, `${location} ${mock ? 'Mock' : 'production'}: imported transform gate`)
  assert.equal(walk(tree, node => node.props?.role === 'button' && node.props.title === '재사용 HTTP 추가 (클릭 또는 드래그)').length, 1, 'ordinary imported templates stay visible')
  if (mock && location === 'local') {
    transform.props.onClick(); imported.props.onClick()
    assert.equal(additions.at(-1).type, 'transform')
    assert.equal(templates.at(-1).node, template, 'imported central transform settings remain intact')
    const data = {}
    transform.props.onDragStart({ dataTransfer: { setData: (key, value) => { data[key] = value } } })
    assert.equal(data['application/flowlink-node'], 'transform')
  }
}
console.log('PASS: PC Mock and production palette expose central transforms and preserve imported templates')
modules['../app/WorkspaceContext'] = { useWorkspace: () => ({ current: { origin: 'local', id: 'local' }, workspaces: [] }) }
modules['../components/AgentSettings'] = { useNodeResources: () => ({ agent: 'server', workspaceId: 'public', key: ['central'], available: true, api: { transformsApi: { list: async () => [] } } }) }
modules['@tanstack/react-query'] = { useQuery: () => ({ data: [] }) }
modules['./frontendMock'] = modules['../lib/frontendMock']
const { useTransformCatalog: renderCatalog } = load('lib/useTransformCatalog.ts')
mockMode = true
assert.equal(renderCatalog().location, '/plugins?space=local%3Alocal', 'Mock common resource browsing keeps the current PC work context')
mockMode = false
assert.equal(renderCatalog().location, '/plugins?space=local%3Alocal', 'production common resource browsing retains the current PC work context')
