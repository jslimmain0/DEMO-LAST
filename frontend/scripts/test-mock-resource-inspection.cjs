// Real API serialization and in-memory desktop Mock handlers; no backend or network calls.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const { pathToFileURL } = require('node:url')
const axios = require('axios')

function loadClient(mockMode) {
  const exported = {}
  const source = fs.readFileSync(path.join(__dirname, '../src/api/client.ts'), 'utf8')
    .replaceAll('import.meta.env.DEV', String(mockMode))
    .replaceAll('import.meta.env.VITE_FRONTEND_MOCK', mockMode ? "'true'" : 'undefined')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(code, {
    exports: exported, window: { location: { origin: 'http://localhost:5174' } },
    require: name => name === 'axios' ? axios : name === '../lib/appBase' ? { appBase: () => '' } : require(name),
  })
  return exported
}

async function run() {
  const { createMockApi } = await import(pathToFileURL(path.join(__dirname, '../dev/mock-api.mjs')))
  const { createDesktopMock } = await import(pathToFileURL(path.join(__dirname, '../dev/mock-desktop.mjs')))
  const handle = createDesktopMock(createMockApi)
  const local = '/api/v1', server = '/api/v1/remote'
  handle('PUT', `${local}/environments/PC-only?workspaceId=local`, { vars: { HOST: 'localhost' } })
  handle('PUT', `${server}/environments/server-only?workspaceId=public`, { vars: { HOST: 'company.test' } })
  const node = { id: 'request', type: 'http', baseUrl: 'https://example.test', path: '/payments' }
  const protocol = handle('POST', `${server}/protocols?workspaceId=public`, { name: 'central-only', spec: { encoding: 'UTF-8', header: [], messages: [{ key: 'request', fields: [{ name: 'value', type: 'string', len: 12 }] }] } })
  const preview = handle('POST', `${local}/agent/tcp-preview/resources`, { node: { protocolId: protocol.id, tcpMessage: 'request', tcpValues: { value: 'PC' } }, workspaceId: 'local', resourceWorkspaceId: 'public', envSource: 'local', env: {} })
  assert.equal(preview.total, 12, 'PC resource preview uses the shared protocol through the new POST body endpoint')
  assert.equal(preview.text.trim(), 'PC')
  const inspect = (prefix, envName, envSource) => handle('POST', `${prefix}/agent/inspect`, { node, envName, envSource })

  const sharedFromPC = inspect(local, 'server-only', 'server')
  assert.equal(sharedFromPC.runtime, 'local', 'selecting server variables must preserve the PC execution location')
  assert.equal(sharedFromPC.ready, true, 'PC inspection must accept an environment owned only by the server')
  assert.equal(inspect(server, 'PC-only', 'local').ready, true, 'server inspection may use explicitly selected PC variables')
  const wrongSource = inspect(local, 'server-only', 'local')
  assert.equal(wrongSource.ready, false)
  assert.equal(wrongSource.targetDiagnostics.configurationReady, false)
  assert.match(wrongSource.issues.join(' '), /내 PC.*server-only/)
  const wrongServer = inspect(server, 'PC-only', 'server')
  assert.equal(wrongServer.ready, false)
  assert.match(wrongServer.issues.join(' '), /서버.*PC-only/)
  assert.equal(inspect(local, 'server-only').ready, false, 'omitting the source keeps the original destination-owned contract')
  assert.equal(inspect(local, null, 'server').ready, true, 'using only common values requires no named environment')

  const execution = handle('POST', `${local}/flows/demo-flow/runs`, { envName: 'server-only', envSource: 'server' })
  assert.equal(execution.environment.source, 'server')
  assert.equal(execution.environment.name, 'server-only')
  assert.throws(() => handle('POST', `${local}/flows/demo-flow/runs`, { envName: 'server-only', envSource: 'local' }), error => error.status === 400 && error.message === wrongSource.issues[0], 'inspection and run must reject the same missing environment')
  handle('PUT', '/__mock/state', { execution: 'inspection-error' })
  assert.equal(inspect(local, 'server-only', 'server').ready, false, 'source selection must not bypass other readiness failures')

  for (const mockMode of [false, true]) {
    const requests = []
    const transport = axios.create({ adapter: async config => {
      requests.push(config)
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
    } })
    const api = loadClient(mockMode).createApi(transport, 'local')
    await api.runsApi.inspectAgent(node, 'server-only', 'server')
    await api.runsApi.inspectAgent(node, '개발')
    const identity = { serverUrl: 'https://company.test', login: 'alice' }
    const snapshot = { SAME_NAME: 'PC', TOKEN: '개인 값' }
    await api.runsApi.inspectAgent(node, '개발', 'local', snapshot, identity)
    await api.runsApi.agentTcpPreview({ id: 'tcp', type: 'tcp', protocolId: protocol.id }, '개발', 'local', snapshot, identity)
    await api.runsApi.inspectAgent(node, null, 'local', {})
    const first = JSON.parse(requests[0].data), unchanged = JSON.parse(requests[1].data)
    assert.equal(first.node.id, 'request')
    assert.equal(first.workspaceId, 'local')
    assert.equal(first.envName, 'server-only')
    assert.equal(first.envSource, 'server', 'both Mock and production serialize the selected environment source')
    assert.equal(first.resourceWorkspaceId, 'public')
    assert.deepEqual(unchanged, { node, workspaceId: 'local', envName: '개발', resourceWorkspaceId: 'public' }, 'existing inspect callers retain ownership while shared resources use public')
    const body = index => JSON.parse(requests[index].data)
    assert.equal(requests[2].url, '/agent/inspect')
    assert.deepEqual(body(2).env, snapshot, 'selected PC values are transmitted without querying the same-named server environment')
    assert.deepEqual(body(2).resourceIdentity, identity)
    assert.equal(body(2).envSource, 'local')
    assert.equal(requests[3].method, 'post')
    assert.equal(requests[3].url, '/agent/tcp-preview/resources')
    assert.deepEqual(body(3), { node: { id: 'tcp', type: 'tcp', protocolId: protocol.id }, workspaceId: 'local', envName: '개발', envSource: 'local', resourceWorkspaceId: 'public', env: snapshot, resourceIdentity: identity })
    assert.deepEqual(body(4).env, {}, 'an explicitly empty PC environment is still a snapshot')
    assert.equal(Object.hasOwn(body(4), 'resourceIdentity'), false, 'unconfigured identities are omitted')
  }
  console.log('PASS: source-specific inspection agrees with Mock run validation; missing source names block readiness')
  console.log('PASS: inspection/TCP body endpoints carry source, public scope, exact PC snapshots and captured identity in Mock and production')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
