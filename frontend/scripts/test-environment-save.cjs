// Run: node frontend/scripts/test-environment-save.cjs
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../src/lib/environments.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const exported = {}
const timers = new Map()
let timerId = 0
const notifications = []
vm.runInNewContext(code, {
  exports: exported, structuredClone,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id),
  require: name => name === '../components/toast' ? { toast: text => notifications.push(text) } : {},
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function run() {
  const initialList = deferred()
  const loadingStore = exported.createEnvironment({ environmentsApi: { list: () => initialList.promise } }, 'test:loading')
  const load = loadingStore.ensureEnvLoaded()
  assert.equal(loadingStore.getLoadStatus(), 'loading')
  loadingStore.setEnvStore({ active: 'new', envs: { new: { DRAFT: 'blocked' } } })
  assert.equal(Object.keys(loadingStore.getEnvStore().envs).length, 0)
  initialList.resolve([{ name: 'existing', vars: { URL: 'loaded' } }])
  await load
  assert.equal(loadingStore.getLoadStatus(), 'ready')
  assert.equal(loadingStore.getEnvStore().envs.existing.URL, 'loaded')
  notifications.length = 0
  console.log('PASS: initial delayed list blocks premature edits and preserves loaded environments')
  const writes = []
  const api = { environmentsApi: { list: async () => [], put: (name, vars) => { const pending = deferred(); writes.push({ name, vars, ...pending }); return pending.promise }, remove: async () => {} } }
  const store = exported.createEnvironment(api, 'test:personal')
  await store.ensureEnvLoaded()
  store.setEnvStore({ active: 'dev', envs: { dev: { URL: 'A' } } })
  const firstFlush = store.flushEnvStore()
  assert.equal(writes.length, 1)
  store.setEnvStore({ active: 'dev', envs: { dev: { URL: 'B' } } })
  let navigationAllowed = false
  const navigationFlush = store.flushEnvStore().then(() => { navigationAllowed = true })
  writes[0].resolve()
  await tick()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].vars.URL, 'B')
  assert.equal(navigationAllowed, false, 'A finishing must not permit navigation while B is unwritten')
  assert.equal(store.getSaveStatus(), 'saving')
  writes[1].resolve()
  await Promise.all([firstFlush, navigationFlush])
  assert.equal(store.getSaveStatus(), 'saved')
  assert.equal(navigationAllowed, true)
  assert.equal(timers.size, 0)
  store.setEnvStore({ active: 'dev', envs: { dev: { URL: 'C' } } })
  const failed = store.flushEnvStore()
  writes[2].reject(new Error('offline'))
  await failed
  assert.equal(store.getSaveStatus(), 'error')
  assert.equal(store.getEnvStore().envs.dev.URL, 'C')
  assert.equal(writes.length, 3, 'failure must stop rather than loop retrying')
  assert.equal(notifications.length, 1)
  const retry = store.flushEnvStore()
  assert.equal(writes.length, 4)
  writes[3].resolve()
  await retry
  assert.equal(store.getSaveStatus(), 'saved')
  await store.prepareForRun()
  const unreadable = exported.createEnvironment({ environmentsApi: { list: async () => { throw new Error('offline') } } }, 'test:offline')
  await assert.rejects(unreadable.prepareForRun(), /불러오지 못했습니다/)
  store.setEnvStore({ active: 'dev', envs: { dev: { URL: 'D' } } })
  const blockedRun = store.prepareForRun()
  await tick()
  writes[4].reject(new Error('offline'))
  await assert.rejects(blockedRun, /저장하지 못했습니다/)
  console.log('PASS: execution preparation rejects environment load and save failures')
  console.log('PASS: delayed A → B save drains before navigation; failure retains draft without retry loop; manual retry saves')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
