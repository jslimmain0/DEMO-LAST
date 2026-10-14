// Runs the real editor mutation callbacks with deferred requests, without browser/network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const protocolHelpers = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/protocolSpec.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: protocolHelpers, TextEncoder })
function source(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
function find(node, predicate) {
  if (predicate(node)) return node
  let result
  ts.forEachChild(node, child => { if (!result) result = find(child, predicate) })
  return result
}
function options(file, context, name = 'save') {
  const tree = source(file)
  const declaration = find(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name)
  const code = ts.transpileModule(`exports.options = ${declaration.initializer.getText(tree)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const exported = {}
  vm.runInNewContext(code, { exports: exported, structuredClone, useMutation: value => value, ...context })
  return exported.options
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function mock() {
  const tree = source('routes/MockServerEditor.tsx')
  const resourceDeclaration = find(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'resourceSpec')
  const resourceExports = {}, scope = { current: { origin: 'local' } }
  vm.runInNewContext(ts.transpileModule(`exports.apply = ${resourceDeclaration.initializer.getText(tree)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { exports: resourceExports, scope })
  const resourceSpec = resourceExports.apply
  assert.equal(resourceSpec({ routes: [] }).envSource, 'local')
  assert.equal(resourceSpec({ routes: [], envSource: 'server' }).envSource, 'server')
  scope.current.origin = 'server'
  assert.equal(resourceSpec({ routes: [] }).envSource, 'server')
  scope.current.origin = 'local'
  const draftRef = { current: { id: 'mock', name: 'Mock', spec: { routes: [{ path: '/A' }] }, dirty: true } }
  const request = deferred(), writes = [], notices = [], activeRef = { current: true }
  let dirty = true
  const save = options('routes/MockServerEditor.tsx', {
    draftRef, activeRef, resourceSpec, detail: { data: { name: 'Mock' } }, mocksApi: { updateSpec: async (id, spec) => { writes.push({ id, spec }); await request.promise } },
    setDirty: value => { dirty = value }, setNote: value => notices.push(value), invalidate: () => {}, apiErrorMessage: () => '저장 실패',
  })
  const pending = save.mutationFn()
  draftRef.current = { ...draftRef.current, spec: { routes: [{ path: '/B' }] } }
  request.resolve(); const saved = await pending; save.onSuccess(saved)
  assert.equal(writes[0].spec.routes[0].path, '/A')
  assert.equal(writes[0].spec.resourceWorkspaceId, 'public')
  assert.equal(writes[0].spec.envSource, 'local')
  assert.equal(Object.hasOwn(writes[0].spec, 'resourceIdentity'), false, 'the browser does not invent persistent Mock server connection metadata')
  assert.equal(draftRef.current.spec.routes[0].path, '/B')
  assert.equal(dirty, true)
  assert.match(notices.at(-1), /추가 편집/)
  // Run the real query hydration effect: a save-triggered refetch must not restore A over B.
  const effect = find(tree, node => ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[1]?.getText(tree) === '[detail.data]')
  let replaced = false
  const effectCode = ts.transpileModule(`(${effect.arguments[0].getText(tree)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(effectCode, { detail: { data: { id: 'mock', name: 'Mock', spec: writes[0].spec } }, draftRef, loadedRef: { current: 'mock' }, setSpec: () => { replaced = true }, setName: () => {}, setDirty: () => {}, setNav: () => {} })
  assert.equal(replaced, false)
  const applyVersion = find(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'applyVersion')
  const exported = {}
  vm.runInNewContext(ts.transpileModule(`exports.apply = ${applyVersion.initializer.getText(tree)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports: exported, draftRef, activeRef, setNote: () => {}, setSpec: value => { draftRef.current.spec = value }, setDirty: value => { dirty = value }, invalidate: () => {} })
  const restored = { id: 'mock', name: 'Mock', spec: { routes: [{ path: '/restored' }] } }
  exported.apply(restored, saved.spec)
  assert.equal(draftRef.current.spec.routes[0].path, '/B', 'restore started before newer editing preserves newer draft')
  exported.apply(restored, structuredClone(draftRef.current.spec))
  assert.equal(draftRef.current.spec.routes[0].path, '/restored', 'explicit restore applies when there is no newer edit')
  assert.equal(dirty, false)
  save.onSuccess({ ...saved, spec: draftRef.current.spec })
  assert.equal(dirty, false, 'successful save of current draft clears dirty')
  draftRef.current = { ...draftRef.current, id: 'other', dirty: true }; dirty = true
  save.onSuccess(saved)
  assert.equal(dirty, true, 'old identity completion does not mark another editor saved')
}
async function plugin() {
  const draftRef = { current: { id: null, name: 'Plugin', source: 'A' } }, dirtyRef = { current: true }
  const request = deferred(); let dirty = true, navigation
  const save = options('routes/Plugins.tsx', {
    draftRef, dirtyRef, selectionRef: { current: 'new:transform' }, activeRef: { current: true }, spaceQuery: '?space=local%3Apc', pluginsApi: { create: async () => { await request.promise; return { id: 'created' } } },
    setDirty: value => { dirty = value }, setDiag: () => {}, invalidate: () => {}, toast: () => {}, setDraft: value => { draftRef.current = value },
    navigateSaved: (to, opts) => { navigation = { to, opts } }, qc: { invalidateQueries: () => {} }, onApiError: () => {},
  })
  const pending = save.mutationFn()
  draftRef.current = { ...draftRef.current, source: 'B' }
  request.resolve(); save.onSuccess(await pending)
  assert.equal(dirty, true); assert.equal(dirtyRef.current, true)
  assert.equal(draftRef.current.source, 'B'); assert.equal(draftRef.current.id, 'created')
  assert.equal(navigation.to, '/plugins/created?space=local%3Apc'); assert.equal(navigation.opts.replace, true)
}
async function protocol() {
  const draftRef = { current: { name: 'Protocol', spec: { messages: [{ key: 'A' }] } } }
  const request = deferred(); let dirty = true, written
  const save = options('components/ProtocolEditor.tsx', {
    draftRef, activeRef: { current: true }, detail: { id: 'protocol' }, validateTcpSettings: protocolHelpers.validateTcpSettings, protocolsApi: { update: async (_id, body) => { written = body; await request.promise } },
    setDirty: value => { dirty = value }, setErrors: () => {}, toast: () => {}, onSaved: () => {}, apiErrorMessage: () => '실패',
  })
  const pending = save.mutationFn()
  draftRef.current = { name: 'Protocol B', spec: { messages: [{ key: 'B' }] } }
  request.resolve(); save.onSuccess(await pending)
  assert.equal(written.name, 'Protocol'); assert.equal(written.spec.messages[0].key, 'A')
  assert.equal(dirty, true); assert.equal(draftRef.current.spec.messages[0].key, 'B')
  save.onSuccess(structuredClone(draftRef.current)); assert.equal(dirty, false)
}
async function protocolPreview() {
  const spec = { header: [{ name: 'code', len: 4, type: 'ascii' }], messages: [{ key: 'REQ1', fields: [{ name: 'value', len: 10, type: 'ascii' }] }, { key: 'RES1:response', fields: [{ name: 'value', len: 4, type: 'ascii' }] }, { key: 'custom-reply', fields: [{ name: 'value', len: 4, type: 'ascii' }] }], framing: { mode: 'fixed', fixedLength: 14 }, responseFraming: { mode: 'fixed', fixedLength: 8 } }
  const previewTree = source('components/ProtocolEditor.tsx')
  const signatureNode = find(previewTree, node => ts.isVariableDeclaration(node) && node.name.getText(previewTree) === 'signature')
  function signature(key, frameDirection) {
    const exported = {}
    vm.runInNewContext(`exports.value = ${signatureNode.initializer.getText(previewTree)}`, { exports: exported, scopeKey: 'server:public', spec, key, frameDirection, action: 'assemble', bytesB64: '', values: {}, envStore: { active: 'dev', envs: { dev: {} } } })
    return exported.value
  }
  assert.notEqual(signature('custom-reply', 'send'), signature('custom-reply', 'recv'), 'changing preview direction invalidates the prior result signature')
  for (const [key, override, expected] of [['REQ1', undefined, 'send'], ['RES1:response', undefined, 'recv'], ['response', undefined, 'recv'], ['custom-reply', 'recv', 'recv']]) {
    const frameDirection = override ?? protocolHelpers.previewDirection(key)
    const token = signature(key, frameDirection), calls = [], events = []
    const preview = options('components/ProtocolEditor.tsx', {
      signature: token, mounted: { current: true }, target: { current: token }, spec, key, frameDirection, action: 'assemble', bytesB64: '',
      fields: [{ name: 'code', type: 'ascii' }, { name: 'value', type: 'ascii' }, { name: 'length', type: 'length' }], values: { code: 'REQ1', value: 'PING', length: 'ignored', stale: 'ignored' },
      ensureEnvLoaded: async () => { events.push('load') }, activeEnvName: () => 'dev', protocolsApi: { preview: async body => { events.push('request'); calls.push(body); return { total: 8, errors: [] } } },
    }, 'preview')
    const result = await preview.mutationFn()
    assert.equal(calls[0].frameDirection, expected)
    assert.equal(Object.hasOwn(calls[0], 'direction'), false, 'wire framing selection preserves the existing SEND codec contract')
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].values)), { code: 'REQ1', value: 'PING' }, 'only fields in the current message are sent')
    assert.deepEqual(events, ['load', 'request'], 'preview reads saved environment without saving it')
    assert.equal(result.signature, token)
  }
  const preparation = deferred(), staleCalls = [], target = { current: signature('REQ1', 'send') }
  const stale = options('components/ProtocolEditor.tsx', { signature: target.current, mounted: { current: true }, target, spec, key: 'REQ1', frameDirection: 'send', action: 'assemble', bytesB64: '', fields: [], values: {}, ensureEnvLoaded: () => preparation.promise, activeEnvName: () => 'dev', protocolsApi: { preview: async body => { staleCalls.push(body) } } }, 'preview')
  const pending = stale.mutationFn()
  target.current = signature('REQ1', 'recv'); preparation.resolve()
  assert.equal(await pending, undefined)
  assert.equal(staleCalls.length, 0, 'switching direction during environment preparation does not send a stale request')
}
async function versions() {
  for (const operation of ['commit', 'restore']) {
    const request = deferred()
    let graph = { name: 'A', nodes: [], edges: [] }, received
    const mutation = options('components/VersionHistoryDialog.tsx', {
      useEditorStore: { getState: () => ({ getGraph: () => graph }) }, flowId: 'flow', commitMsg: '',
      flowsApi: { saveVersion: async () => { await request.promise; return { versionNo: 2 } }, restoreVersion: async () => { await request.promise; return { versionNo: 2 } } },
      onRestored: snapshot => { received = snapshot }, onClose: () => {}, toast: () => {}, setCommitMsg: () => {}, qc: { invalidateQueries: () => {} },
    }, operation)
    const pending = mutation.mutationFn(1)
    graph = { ...graph, name: 'B' }
    request.resolve(); mutation.onSuccess(await pending)
    assert.equal(received.name, 'A', `${operation} reload compares against the request snapshot`)
  }
  const tree = source('routes/Editor.tsx')
  const hydration = find(tree, node => ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[1]?.getText(tree) === '[flowQuery.data, loadGraph]')
  const hydrationCode = ts.transpileModule(`exports.hydrate = ${hydration.arguments[0].getText(tree)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const hydrationExports = {}, hydratedFlowRef = { current: null }; let hydrationCount = 0
  vm.runInNewContext(hydrationCode, { exports: hydrationExports, flowQuery: { data: { id: 'flow', graph: {} } },
    useEditorStore: { getState: () => ({ flowId: 'flow', dirty: true }) }, hydratedFlowRef, savedVersionRef: { current: null }, loadGraph: () => { hydrationCount++ } })
  hydrationExports.hydrate()
  assert.equal(hydrationCount, 1, 're-entering a discarded flow loads the saved graph')
  hydrationExports.hydrate()
  assert.equal(hydrationCount, 1, 'background reload within the mounted editor preserves draft')
  const declaration = find(tree, node => ts.isVariableDeclaration(node) && node.name.getText(tree) === 'reloadSavedGraph')
  const code = ts.transpileModule(`exports.reload = ${declaration.initializer.getText(tree)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  let graph = { name: 'B', nodes: [], edges: [] }, loaded = false
  const exported = {}, notices = []
  vm.runInNewContext(code, { exports: exported, getGraph: () => graph, flowQuery: { refetch: async () => ({ data: { id: 'flow', name: 'A', graph: { name: 'A' }, currentVersion: 2 } }) },
    isCurrentEditor: () => true, useEditorStore: { getState: () => ({ dirty: true }) }, loadGraph: () => { loaded = true }, savedVersionRef: { current: null }, toast: text => notices.push(text) })
  await exported.reload({ ...graph, name: 'A' })
  assert.equal(loaded, false); assert.equal(notices.length, 1)
  await exported.reload(graph)
  assert.equal(loaded, true, 'explicit reload replaces the unchanged draft after user choice')
}
Promise.resolve().then(mock).then(plugin).then(protocol).then(protocolPreview).then(versions).then(() => process.stdout.write('authoring save races and protocol preview directions: PASS\n')).catch(error => { console.error(error); process.exitCode = 1 })
