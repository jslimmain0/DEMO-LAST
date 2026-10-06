// Run: node frontend/scripts/test-plugin-resources.cjs. Real hooks and picker callbacks, no network/MCP.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const jsx = (type, props) => ({ type, props })
const react = { useMemo: f => f(), useState: initial => [initial, () => {}], useEffect() {}, useLayoutEffect() {}, useRef: () => ({ current: null }) }
let connected = true, refreshes = 0, opened, options
const scope = { current: { origin: 'server', id: 'team' }, connected: true, remoteKey: 'server:alice', workspaces: [{origin:'local',id:'pc',name:'개인 공간'}, {origin:'server',id:'team',name:'개발팀'}], agentApi: (agent, workspaceId) => ({ transformsApi: { list: () => `${agent}:${workspaceId}` } }) }
let query = { isSuccess: true, isPending: false, isError: false, data: [{id:'same',label:'same',inputs:[],outputs:[],params:[]}], refetch: () => refreshes++ }
function load(file, modules, extra = '') {
  const exported = {}
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8') + extra, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports: exported, require: name => modules[name] ?? {}, window: {open: url => {opened = url}}, document: {body:{}}, setTimeout: () => {} })
  return exported
}
const base = { react, 'react/jsx-runtime': {jsx,jsxs:jsx}, 'react-router-dom': {Link:'link'}, '../app/WorkspaceContext': {useWorkspace: () => ({...scope, connected})}, '../auth/AuthContext': {useAuth: () => ({desktop:{}})}, 'react-dom': {createPortal: value => value}, '../lib/appBase': {appUrl: value => value} }
const agents = load('components/AgentSettings.tsx', base)
const catalogModule = load('lib/useTransformCatalog.ts', {...base, '../components/AgentSettings': agents, '@tanstack/react-query': {useQuery: value => {options = value; return query}}})
const notices = load('components/PluginResources.tsx', base)
function walk(node, predicate, results = []) {
  if (Array.isArray(node)) node.forEach(n => walk(n,predicate,results))
  else if (node && typeof node === 'object') {if(predicate(node)) results.push(node); walk(node.props?.children,predicate,results)}
  return results
}
function text(node) {return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : ''}
let catalog = catalogModule.useTransformCatalog({type:'transform', executionAgent:'local'})
assert.equal(catalog.resources.workspaceId, 'team'); assert.equal(options.queryFn(), 'server:team')
assert.equal(options.queryKey[0], 'transforms'); assert.match(catalog.newLocation, /space=server%3Ateam&new=transform/)
catalog = catalogModule.useTransformCatalog({type:'transform', executionAgent:'server'})
assert.equal(options.queryFn(), 'server:team'); assert.match(catalog.newLocation, /space=server%3Ateam&new=transform/)
assert.match(catalogModule.useTransformCatalog().label, /개발팀/)
assert.equal(agents.AgentSettings({node:{type:'transform'},update(){},disabled:false}), null)
assert.equal(agents.nodeAgent({type:'http',executionAgent:'local'},'server'), 'local')
assert.equal(agents.nodeAgent({type:'transform',executionAgent:'local'},'server'), 'server')
scope.current = {origin:'local',id:'pc'}
catalog = catalogModule.useTransformCatalog(); assert.equal(options.enabled,false); assert.equal(catalog.allowed,false)
assert.match(text(notices.PluginResourceNotice({catalog})),/공용·팀 워크스페이스에서만/)
scope.current = {origin:'server',id:'team'}
connected = false; catalogModule.useTransformCatalog(); assert.equal(options.enabled, false); connected = true
query = {...query,isSuccess:false,isPending:true}
let notice = notices.PluginResourceNotice({catalog:catalogModule.useTransformCatalog(),selected:['missing']})
assert.match(text(notice), /확인 중/); assert.doesNotMatch(text(notice), /자동 복사/)
query = {...query,isPending:false,isError:true}
assert.match(text(notices.PluginResourceNotice({catalog:catalogModule.useTransformCatalog(),selected:['missing']})), /불러오지 못했습니다/)
query = {...query,isSuccess:true,isError:false}
notice = notices.PluginResourceNotice({catalog:catalogModule.useTransformCatalog(),selected:['missing']})
assert.match(text(notice), /개발팀에 승인된 플러그인이 없습니다/)
walk(notice,n => n.type === 'button')[0].props.onClick(); assert.equal(refreshes,1)
const picker = load('components/TransformPicker.tsx',base)
const loading = picker.TransformPicker({list:[],value:'same',loading:true,onChange(){}})
assert.match(text(loading), /확인 중/); assert.doesNotMatch(text(loading), /없음/)
const codecOps = load('lib/mockCodecOps.ts',base)
const codecModules = {...base,'./PluginResources':notices,'../lib/useTransformCatalog':catalogModule,'./TransformPicker':{...picker,TransformPicker:'picker'},'../lib/mockCodecOps':codecOps}
const fields = load('components/FieldCodecButton.tsx',codecModules,'\nexport { StepPopover };')
const wizard = fields.CodecStepWizard({list:query.data,sources:[],fieldHints:{request:[],response:[]},defaultSide:'request',onCancel(){},onAdd(){}})
walk(wizard,n => n.type === 'picker')[0].props.onCreateNew(); assert.match(opened,/space=server%3Ateam&new=transform/)
const pop = fields.StepPopover({anchor:null,field:'a',list:query.data,sources:[],sides:['request'],defaultSide:'request',editing:null,onClose(){},onSave(){}})
walk(pop,n => n.type === 'picker')[0].props.onCreateNew(); assert.match(opened,/space=server%3Ateam&new=transform/)
const mock = load('components/MockCodecEditor.tsx',{...codecModules,'./FieldCodecButton':fields},'\nexport { StepCard };')
const card = mock.StepCard({step:{id:''},index:0,side:'request',list:query.data,sources:[],hints:[],onChange(){},onMove(){},onRemove(){}})
walk(card,n => n.type === 'picker')[0].props.onCreateNew(); assert.match(opened,/space=server%3Ateam&new=transform/)
console.log('PASS: central-only plugin catalog·personal rejection·transform fixed server·HTTP retains PC choice·explicit creation space·loading/error/missing states')

async function previewEnvironments() {
  const file = 'panels/TransformPreview.tsx', source = fs.readFileSync(path.join(__dirname,'../src',file),'utf8')
  const tree = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  let run
  function find(n) {if(ts.isVariableDeclaration(n) && n.name.getText(tree) === 'run') run = n.initializer.getText(tree); ts.forEachChild(n,find)}
  find(tree)
  const calls = []
  let result, active = 'dev'
  const context = {signature:'same',mounted:{current:true},target:{current:'same'},resources:{available:true},config:{},inputs:{},transform:{id:'same'},activeEnvName:()=>active,prepareForRun:async()=>{},setBusy(){},setResult:v=>{result=v},transformsApi:{preview:async(id,request)=>{calls.push(request); return {ok:true,outputs:{}}}}}
  const exported = {}
  vm.runInNewContext(ts.transpileModule(`exports.run = ${run}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exported,...context})
  await exported.run(); assert.equal(calls.at(-1).environment,'dev')
  active = ''; await exported.run(); assert.equal(calls.at(-1).environment,'')
  context.resources.available = false; await exported.run(); assert.equal(calls.length,2); assert.match(result.error,/공용·팀 공간과 서버 로그인/)
  console.log('PASS: transform preview uses workflow environment and blocks unavailable central plugins')
}
previewEnvironments().catch(error=>{console.error(error);process.exitCode=1})
