// Run: node frontend/scripts/test-workspace-scope.cjs
// Real API factory + Axios adapter: no backend or MCP traffic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const axios = require('axios')

const source = fs.readFileSync(path.join(__dirname, '../src/api/client.ts'), 'utf8').replaceAll('import.meta.env.DEV', 'false')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const exportsObject = {}
vm.runInNewContext(code, { exports: exportsObject, setTimeout: fn => setTimeout(fn, 0), require: name => name === 'axios' ? axios : name === '../lib/appBase' ? { appBase: () => '/flowlink' } : require(name), window: { location: { origin: 'http://localhost:18180' } } })
const requests = []
const adapter = async config => { requests.push(config); return { status: 200, statusText: 'OK', data: {}, headers: {}, config } }
const local = axios.create({ baseURL: 'http://localhost:18180/api/v1', adapter })
const remote = axios.create({ baseURL: 'http://localhost:18180/api/v1/remote', adapter })
const personal = exportsObject.createApi(local, 'personal-id')
const team = exportsObject.createApi(remote, 'team-id', 'https://flow.company/flowlink', 'alice')

async function run() {
  await personal.environmentsApi.put('dev', { marker: 'PERSONAL' })
  await team.environmentsApi.put('dev', { marker: 'TEAM' })
  await personal.secretsApi.put('KEY', 'private', 'dev')
  await team.protocolsApi.create('wire', { encoding: 'UTF-8', header: [], messages: [] })
  await team.pluginsApi.create({ source: 'plugin source' })
  await team.runsApi.list({ limit: 4, status: 'FAILED' })
  await personal.flowsApi.list()
  assert.deepEqual(requests.map(r => r.baseURL), [local.defaults.baseURL, remote.defaults.baseURL, local.defaults.baseURL, remote.defaults.baseURL, remote.defaults.baseURL, remote.defaults.baseURL, local.defaults.baseURL])
  assert.deepEqual(requests.map(r => r.params.workspaceId), ['personal-id', 'team-id', 'personal-id', 'team-id', 'team-id', 'team-id', 'personal-id'])
  assert.equal(requests[5].params.status, 'FAILED')
  assert.equal(requests[5].params.limit, 4)
  assert.equal(JSON.parse(requests[3].data).workspaceId, 'team-id')
  assert.equal(JSON.parse(requests[4].data).workspaceId, 'team-id')
  assert.equal(requests[1].headers.get('X-FlowLink-Account'), 'alice')
  assert.equal(requests[1].headers.get('X-FlowLink-Server'), 'https://flow.company/flowlink')
  assert.equal(requests[0].headers.get('X-FlowLink-Account'), undefined)
  assert.equal(team.mockBaseUrl('payments'), 'https://flow.company/flowlink/mock/ws/team-id/payments')
  assert.equal(team.mockBaseUrl('same', null, '/mock/ws/other-team/same'), 'https://flow.company/flowlink/mock/ws/other-team/same')
  assert.equal(personal.mockBaseUrl('orders'), 'http://localhost:18180/flowlink/mock/ws/personal-id/orders')
  assert.equal(team.resourceUrl('/hooks/run'), 'https://flow.company/flowlink/hooks/run')
  const managedRequests = []
  const managed = exportsObject.createApi(axios.create({ adapter: async config => {
    managedRequests.push(config)
    const data = config.method === 'post' ? { id: 'run-id', status: 'WAITING', pendingAgent: { status: 'PENDING' } } : { id: 'run-id', status: 'SUCCEEDED', nodes: [{ nodeId: 'node-id', ok: true, durationMs: 12, outputJson: '{"orderId":42}' }] }
    return { status: 200, statusText: 'OK', data, headers: {}, config }
  } }), 'team-id')
  const result = await managed.runsApi.runNode('flow-id', 'node-id')
  assert.equal(managedRequests[0].url, '/flows/flow-id/runs')
  assert.equal(JSON.parse(managedRequests[0].data).onlyNodeId, 'node-id')
  assert.equal(managedRequests.filter(r => r.method === 'post').length, 1)
  assert.equal(result.executionId, 'run-id')
  assert.equal(result.output.orderId, 42)
  const unknownRequests = []
  const unknown = exportsObject.createApi(axios.create({ adapter: async config => {
    unknownRequests.push(config)
    return { status: 200, statusText: 'OK', data: { id: 'unknown-id', status: 'WAITING', pendingAgent: { status: 'UNKNOWN' } }, headers: {}, config }
  } }))
  await assert.rejects(unknown.runsApi.runNode('flow-id', 'node-id'), /unknown-id/)
  assert.equal(unknownRequests.length, 1)
  console.log('PASS: fixed local/server transport, workspace params, create ownership, captured account, and listener URLs')
  console.log('PASS: single-node managed run, native agent polling, output conversion, UNKNOWN stops without retry')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
