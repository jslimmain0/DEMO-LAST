const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript'), axios = require('axios')
const source = fs.readFileSync(path.join(__dirname, '../src/auth/auth.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(handler, token = 'current-login', sharedStorage) {
  const stored = sharedStorage ?? new Map(token ? [['fl:token', token]] : []), requests = [], exports = {}
  let reloads = 0
  const http = axios.create({ adapter: async config => {
    requests.push(config)
    const status = await handler(config)
    const response = { status, statusText: String(status), data: { username: 'synthetic-user' }, headers: {}, config }
    if (status >= 400) throw new axios.AxiosError('synthetic failure', 'ERR_BAD_REQUEST', config, undefined, response)
    return response
  } })
  vm.runInNewContext(code, {
    exports, require: () => ({ http }),
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    window: { location: { reload: () => reloads++ } },
  })
  exports.attachAuthInterceptors()
  exports.attachAuthInterceptors()
  return { http, auth: exports, requests, stored, get reloads() { return reloads }, get probes() { return requests.filter(config => config.url === '/auth/me').length } }
}

test('a feature-specific 401 keeps a valid company login and propagates the original error', async () => {
  const f = fixture(config => config.url === '/auth/me' ? 200 : 401)
  await assert.rejects(f.http.get('/plugins/scripts'), error => error.config.url === '/plugins/scripts' && error.response.status === 401)
  assert.equal(f.auth.getAccessToken(), 'current-login')
  assert.equal(f.stored.get('fl:token'), 'current-login')
  assert.equal(f.probes, 1)
  assert.equal(f.requests.find(config => config.url === '/auth/me').timeout, 10_000)
  assert.equal(f.reloads, 0)
})

test('concurrent 401 responses validate one session and log out a genuinely invalid token once', async () => {
  const gate = pending(), f = fixture(config => config.url === '/auth/me' ? gate.promise : 401)
  const results = Promise.allSettled([f.http.get('/flows'), f.http.get('/workspaces'), f.http.get('/environments')])
  await tick()
  assert.equal(f.probes, 1)
  gate.resolve(401)
  assert.ok((await results).every(result => result.status === 'rejected'))
  assert.equal(f.auth.getAccessToken(), null)
  assert.equal(f.stored.has('fl:token'), false)
  assert.equal(f.reloads, 1)
})

test('a delayed response for an old token cannot clear a newer login', async () => {
  const gate = pending(), f = fixture(() => gate.promise, 'old-login')
  const result = assert.rejects(f.http.get('/flows'))
  await tick()
  f.auth.setToken('new-login')
  gate.resolve(401)
  await result
  assert.equal(f.auth.getAccessToken(), 'new-login')
  assert.equal(f.probes, 0)
  assert.equal(f.reloads, 0)
})

test('an old tab cannot delete a newer token saved by another tab', async () => {
  const shared = new Map([['fl:token', 'old-login']]), gate = pending()
  const oldTab = fixture(() => gate.promise, 'old-login', shared)
  const newTab = fixture(() => 200, 'old-login', shared)
  const result = assert.rejects(oldTab.http.get('/flows'))
  await tick()
  newTab.auth.setToken('new-login')
  gate.resolve(401)
  await result
  assert.equal(oldTab.auth.getAccessToken(), 'new-login')
  assert.equal(newTab.auth.getAccessToken(), 'new-login')
  assert.equal(shared.get('fl:token'), 'new-login')
  assert.equal(oldTab.probes, 0)
  assert.equal(oldTab.reloads, 0)
})

test('a tab observes a newer shared token before completing its old session check', async () => {
  const shared = new Map([['fl:token', 'old-login']]), gate = pending()
  const oldTab = fixture(config => config.url === '/auth/me' ? gate.promise : 401, 'old-login', shared)
  const newTab = fixture(() => 200, 'old-login', shared)
  const result = assert.rejects(oldTab.http.get('/flows'))
  await tick()
  assert.equal(oldTab.probes, 1)
  newTab.auth.setToken('new-login')
  gate.resolve(401)
  await result
  assert.equal(shared.get('fl:token'), 'new-login')
  assert.equal(oldTab.reloads, 0)
})

test('a failed session probe cannot clear a login that changed while the probe was running', async () => {
  const gate = pending(), f = fixture(config => config.url === '/auth/me' ? gate.promise : 401)
  const result = assert.rejects(f.http.get('/flows'))
  await tick()
  assert.equal(f.probes, 1)
  f.auth.setToken('new-login')
  gate.resolve(401)
  await result
  assert.equal(f.auth.getAccessToken(), 'new-login')
  assert.equal(f.reloads, 0)
})

test('authorization, server and network failures during session validation preserve the login', async () => {
  for (const status of [403, 500, 'network']) {
    const f = fixture(config => {
      if (config.url !== '/auth/me') return 401
      if (status === 'network') throw new Error('synthetic network failure')
      return status
    })
    await assert.rejects(f.http.get('/protocols'))
    assert.equal(f.auth.getAccessToken(), 'current-login')
    assert.equal(f.reloads, 0)
  }
})

test('auth endpoint errors, ordinary server failures and guest requests never start a logout check', async () => {
  const f = fixture(config => config.url === '/flows' ? 500 : 401)
  await assert.rejects(f.http.get('/auth/github/device/poll'))
  await assert.rejects(f.http.get('/flows'))
  assert.equal(f.probes, 0)
  assert.equal(f.auth.getAccessToken(), 'current-login')
  assert.equal(f.reloads, 0)
  const guest = fixture(() => 401, null)
  await assert.rejects(guest.http.get('/flows'))
  assert.equal(guest.probes, 0)
  assert.equal(guest.reloads, 0)
})

function bootFixture(readMe) {
  const stored = new Map([['fl:token', 'old-login']]), reads = [], removed = []
  const auth = {
    authApi: {
      config: async () => ({ mode: 'github', runtime: { kind: 'server', name: 'synthetic-server' } }),
      me: () => { const token = stored.get('fl:token'); reads.push(token); return readMe(token) },
    },
    attachAuthInterceptors() {}, getAccessToken: () => stored.get('fl:token') ?? null,
    setToken: token => { if (token) stored.set('fl:token', token); else { removed.push(stored.get('fl:token')); stored.delete('fl:token') } },
  }
  const exports = {}, source = fs.readFileSync(path.join(__dirname, '../src/auth/AuthContext.tsx'), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(`${compiled}\nexports.testBoot = boot`, {
    exports, require: name => name === './auth' ? auth : name === 'react' ? { createContext: () => ({}) } : {},
  })
  return { boot: exports.testBoot, stored, reads, removed }
}

test('bootstrap rechecks a newer shared login instead of deleting it after an old 401 or 403', async () => {
  for (const status of [401, 403]) {
    const gate = pending(), f = bootFixture(async token => {
      if (token === 'old-login') { await gate.promise; throw { response: { status } } }
      return { username: 'new-user' }
    })
    const result = f.boot()
    await tick()
    f.stored.set('fl:token', 'new-login')
    gate.resolve()
    const boot = await result
    assert.equal(boot.me.username, 'new-user')
    assert.equal(boot.needsLogin, undefined)
    assert.deepEqual(f.reads, ['old-login', 'new-login'])
    assert.deepEqual(f.removed, [])
    assert.equal(f.stored.get('fl:token'), 'new-login')
  }
})

test('bootstrap never accepts an old account response after another tab changes or removes the login', async () => {
  for (const nextToken of ['new-login', null]) {
    const gate = pending(), f = bootFixture(async token => {
      if (token === 'old-login') await gate.promise
      return { username: token === 'old-login' ? 'old-user' : 'new-user' }
    })
    const result = f.boot()
    await tick()
    if (nextToken) f.stored.set('fl:token', nextToken); else f.stored.delete('fl:token')
    gate.resolve()
    const boot = await result
    assert.equal(boot.me?.username ?? null, nextToken ? 'new-user' : null)
    assert.equal(boot.needsLogin, nextToken ? undefined : true)
    assert.deepEqual(f.removed, [])
  }
})

test('bootstrap still clears a genuinely rejected token and preserves it on temporary failures', async () => {
  for (const status of [401, 403, 500, 'network']) {
    const f = bootFixture(async () => { throw status === 'network' ? new Error('synthetic network failure') : { response: { status } } })
    const boot = await f.boot(), expired = status === 401 || status === 403
    assert.equal(boot.me, null)
    assert.equal(boot.needsLogin, expired ? true : undefined)
    assert.equal(f.stored.get('fl:token'), expired ? undefined : 'old-login')
    assert.equal(f.removed.length, expired ? 1 : 0)
  }
})
