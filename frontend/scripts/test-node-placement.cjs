const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const exported = {}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/canvas/nodePlacement.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: exported })
const { findNodePlacement } = exported
const size = { width: 230, height: 120 }, view = { x: -120, y: 230, width: 1050, height: 600 }
const rects = []
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
for (let index = 0; index < 12; index++) {
  const point = findNodePlacement(view, size, rects)
  const rect = { x: point.x, y: point.y, ...size }
  assert.equal(rects.some(existing => overlaps(rect, existing)), false, 'rapid successive unmeasured additions never overlap')
  if (index < 3) assert.equal(point.visible, true, 'first authoring nodes remain in viewport')
  if (point.visible) assert.ok(rect.x >= view.x && rect.y >= view.y && rect.x + size.width <= view.x + view.width && rect.y + size.height <= view.y + view.height)
  rects.push(rect)
}
const original = JSON.stringify(rects)
findNodePlacement(view, { width: 396, height: 264 }, rects)
assert.equal(JSON.stringify(rects), original, 'placement does not move existing nodes')
const giant = { x: -300, y: -300, width: 2000, height: 2000 }
const fallback = findNodePlacement({ x: 0, y: 0, width: 400, height: 300 }, size, [giant])
assert.equal(fallback.visible, false)
assert.equal(overlaps({ ...fallback, ...size }, giant), false, 'full viewport fallback is outside occupied bounds')
const tall = { x: 200, y: 230, width: 230, height: 480 }
const beside = findNodePlacement(view, size, [tall])
assert.equal(beside.visible, true); assert.equal(overlaps({ ...beside, ...size }, tall), false)
process.stdout.write('click node placement: PASS\n')
