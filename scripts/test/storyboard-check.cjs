// Run: node scripts/test/storyboard-check.cjs
// Checks the review artifact's rules; does not call a backend or MCP server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../../docs/FLOWLINK_STORYBOARD.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
vm.runInNewContext(script.slice(0, script.indexOf('function renderShell()')) + String.raw`
  assert.equal(blocked(), false, 'PC → server → PC is ready while signed in');
  nodes[0].agent = 'server';
  assert.equal(mismatch(nodes[0]), true, 'personal Mock remains on PC');
  assert.equal(blocked(), true, 'wrong Mock origin blocks execution');
  nodes[0].agent = 'local';
  state.online = false;
  assert.equal(blocked(), true, 'server-dependent flow waits during disconnect');
  state.space = 'personal';
  state.signed = false;
  nodes[1].agent = 'local';
  nodes[1].mock = 'none';
  assert.equal(blocked(), false, 'personal PC-only flow works without server login');
  state.space = 'team';
  assert.equal(blocked(), true, 'team flow requires remote access even with PC nodes');
  assert.equal(nextPort('personal'), 9510);
  mocks.push({space:'personal', type:'TCP', port:9510});
  assert.equal(nextPort('personal'), 9511, 'PC ports do not collide');
  assert.equal(nextPort('qa'), 9103);
  mocks.push({space:'qa', type:'TCP', port:9103});
  assert.equal(nextPort('public'), 9104, 'all remote spaces share the server port pool');
  assert.match(endpoint({space:'qa', type:'HTTP', slug:'users'}), /\/mock\/qa\/users\//);
  assert.match(endpoint({space:'personal', type:'HTTP', slug:'users'}), /127\.0\.0\.1/);
  assert.equal(spaces.personal.kind, 'pc');
  assert.ok(['public','team','qa'].every(id => spaces[id].kind === 'server'));
  assert.equal(esc('<script>'), '&lt;script&gt;');
`, {assert}, {timeout: 1000});
console.log('Storyboard syntax and routing rules: PASS');
