// Actual iframe launcher + shared Escape registry with a small DOM; no browser or network.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const listeners = new Map(), submissions = []
let failSubmit = false
const window = {
  addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(handler) },
  removeEventListener(type, handler) { listeners.get(type)?.delete(handler) },
}
const emit = (type, event) => { for (const listener of [...listeners.get(type) ?? []]) listener(event) }
const count = type => listeners.get(type)?.size ?? 0
class Element {
  constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.attributes = {}; this.parent = null; if (tag === 'iframe') this.contentWindow = {} }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null }
  remove() { this.parent?.removeChild(this) }
  setAttribute(name, value) { this.attributes[name] = value }
  getAttribute(name) { return this.attributes[name] }
  get isConnected() { return this === document.body || !!this.parent?.isConnected }
  focus() { document.activeElement = this }
  submit() {
    if (failSubmit) throw new Error('submission failed')
    submissions.push({ method: this.method, action: this.action, target: this.target, fields: this.children.map(child => ({ key: child.name, value: child.value })) })
  }
}
const document = { body: new Element('body'), activeElement: null, createElement: tag => new Element(tag) }
function find(element, predicate) { if (predicate(element)) return element; for (const child of element.children) { const found = find(child, predicate); if (found) return found } }
const overlay = nodeId => find(document.body, element => element.id === `fl-iframe-ov-${nodeId}`)
function load(file, modules) {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(code, { exports: exported, require: name => modules[name] ?? {}, window, document })
  return exported
}
const escape = load('components/useEscapeClose.ts', { react: {} })
const { openFormIframe } = load('lib/popup.ts', { '../components/useEscapeClose': escape })
const trigger = document.body.appendChild(new Element('button'))
trigger.focus()
const form = { nodeId: 'payment', nodeName: '결제 승인', action: 'https://company.test/pay', method: 'POST', fields: [{ key: 'order', value: 'A&B' }, { key: '', value: 'skip' }] }

assert.equal(openFormIframe(form), null)
let current = overlay(form.nodeId)
const dialog = find(current, element => element.getAttribute('role') === 'dialog')
assert.equal(dialog.getAttribute('aria-modal'), 'true')
assert.equal(dialog.getAttribute('aria-label'), '결제 승인')
assert.equal(find(dialog, element => element.tag === 'span').textContent, '결제 승인')
assert.equal(find(dialog, element => element.tag === 'iframe').title, '결제 승인 내용')
const oldFrame = find(dialog, element => element.tag === 'iframe')
const oldClose = find(dialog, element => element.tag === 'button')
assert.equal(oldClose.getAttribute('aria-label'), '결제 승인 닫기')
assert.equal(document.activeElement, oldClose)
assert.equal(find(document.body, element => element.tag === 'form'), undefined)
assert.equal(JSON.stringify(submissions[0]), JSON.stringify({ method: 'post', action: form.action, target: 'flowlink_iframe_payment', fields: [{ key: 'order', value: 'A&B' }] }))
assert.equal(count('message'), 1)
assert.equal(count('keydown'), 1)

assert.equal(openFormIframe(form), null)
assert.equal(current.isConnected, false)
current = overlay(form.nodeId)
assert.equal(count('message'), 1, 'replacement removes the old message listener')
assert.equal(count('keydown'), 1, 'replacement unregisters the old Escape handler')
oldClose.onclick()
assert.equal(overlay(form.nodeId), current, 'a stale close callback cannot close the replacement')
emit('message', { source: oldFrame.contentWindow, data: 'fl-close' })
emit('message', { source: {}, data: 'fl-close-payment' })
assert.equal(overlay(form.nodeId), current, 'messages from other or replaced frames cannot close this dialog')
emit('message', { source: find(current, element => element.tag === 'iframe').contentWindow, data: 'fl-close-payment' })
assert.equal(overlay(form.nodeId), undefined)
assert.equal(count('message'), 0)
assert.equal(count('keydown'), 0)
assert.equal(document.activeElement, trigger)

assert.equal(openFormIframe(form), null)
emit('keydown', { key: 'Escape', defaultPrevented: true })
assert.ok(overlay(form.nodeId), 'Escape already handled by an editor does not close the dialog')
emit('keydown', { key: 'Escape', isComposing: true, defaultPrevented: false })
emit('keydown', { key: 'Escape', keyCode: 229, defaultPrevented: false })
assert.ok(overlay(form.nodeId), 'IME cancellation must preserve the active dialog')
emit('keydown', { key: 'Escape', defaultPrevented: false })
assert.equal(overlay(form.nodeId), undefined)
assert.equal(count('message'), 0)
assert.equal(count('keydown'), 0)
assert.equal(document.activeElement, trigger)

failSubmit = true
assert.match(openFormIframe(form), /iframe form 제출 실패.*submission failed/)
assert.equal(overlay(form.nodeId), undefined, 'failed submission removes the orphan overlay')
assert.equal(find(document.body, element => element.tag === 'form'), undefined)
assert.equal(count('message'), 0)
assert.equal(count('keydown'), 0)
assert.equal(document.activeElement, trigger)
failSubmit = false
assert.equal(openFormIframe({ ...form, nodeName: '', method: 'GET' }), null, 'failed submission leaves no stale instance behind')
current = overlay(form.nodeId)
assert.equal(find(current, element => element.tag === 'iframe').title, '폼 전송 내용')
current.onclick({ target: current })
assert.equal(overlay(form.nodeId), undefined)
assert.equal(count('message'), 0)
assert.equal(count('keydown'), 0)
assert.equal(document.activeElement, trigger)
console.log('PASS: iframe dialog labels/focus, replacement listener cleanup, source-specific close messages, shared Escape cleanup')
console.log('PASS: submission failures remove both hidden form and overlay/listeners; retry and backdrop close restore focus')
