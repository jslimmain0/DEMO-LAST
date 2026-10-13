const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')

test('protocol fetch recovery keeps the same editor and its draft when cached data exists', () => {
  const protocol = { id: 'protocol', name: '전문', encoding: 'UTF-8', messageCount: 1 }
  let failed = false, cached = true, retries = 0
  const exports = {}, jsx = (type, props, key) => ({ type, props, key })
  const modules = {
    react: { useState: value => [value, () => {}], useMemo: callback => callback(), useEffect() {}, useRef: value => ({ current: value }) },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '@tanstack/react-query': {
      useQuery: options => options.queryKey[0] === 'protocols' ? { data: [protocol] } : { data: cached ? protocol : undefined, isError: failed, error: new Error('조회 실패'), refetch: () => retries++ },
      useMutation: () => ({ isPending: false }), useQueryClient: () => ({ invalidateQueries() {} }),
    },
    'react-router-dom': { useParams: () => ({ id: protocol.id }), useNavigate: () => () => {} },
    '../app/WorkspaceContext': { useCentralApi: () => ({ protocolsApi: {} }), useWorkspace: () => ({ connected: true, remoteKey: 'server:account:true', workspaces: [{ id: 'public', origin: 'server', myRole: 'OWNER' }] }) },
    '../auth/AuthContext': { usePermissions: () => ({ canEdit: true }) },
    '../app/AppShell': { AppShellTier1: 'shell' }, '../components/ProtocolEditor': { ProtocolEditor: 'protocol-editor' },
    '../components/PageHeader': { PageHeader: 'page-header' }, '../design/ui': { ui: {} }, '../lib/apiError': { apiErrorMessage: error => error.message },
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/routes/Protocols.tsx'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: name => modules[name] ?? {} })
  const find = (node, predicate) => Array.isArray(node) ? node.flatMap(child => find(child, predicate)) : node && typeof node === 'object' ? [...(predicate(node) ? [node] : []), ...find(node.props?.children, predicate)] : []
  const clean = exports.Protocols(), editor = find(clean, node => node.type === 'protocol-editor')[0]
  assert.ok(editor)
  failed = true
  const recovered = exports.Protocols(), kept = find(recovered, node => node.type === 'protocol-editor')[0]
  assert.equal(kept.key, editor.key)
  assert.equal(kept.props.detail, protocol)
  assert.equal(find(recovered, node => node.props?.role === 'alert').length, 1)
  const retry = find(recovered, node => node.type === 'button' && node.props.children === '다시 불러오기')[0]
  retry.props.onClick(); assert.equal(retries, 1)
  cached = false
  const missing = exports.Protocols()
  assert.equal(find(missing, node => node.type === 'protocol-editor').length, 0)
  assert.equal(find(missing, node => node.props?.role === 'alert').length, 1)
})
