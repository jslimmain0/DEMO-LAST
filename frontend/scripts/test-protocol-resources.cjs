// Actual TCP panel: storage identity, disconnected/loading/error/missing states. No network/MCP.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
// 공용 컨트롤 스타일(design/ui)은 순수 상수 모듈이라 실제 구현을 그대로 쓴다.
const designUi = (() => { const out = {}; require('node:vm').runInNewContext(require('typescript').transpileModule(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/design/ui.ts'), 'utf8'), { compilerOptions: { module: require('typescript').ModuleKind.CommonJS, target: require('typescript').ScriptTarget.ES2022 } }).outputText, { exports: out }); return out })()
const jsx = (type, props) => ({type, props})
const scope = {current:{origin:'server',id:'team'},connected:true,workspaces:[{origin:'local',id:'pc',name:'개인 공간'},{origin:'server',id:'team',name:'개발팀'}],agentApi:(origin,space)=>({protocolsApi:{list:()=>`${origin}:${space}`,get:id=>id}})}
const base = {react:{useMemo:f=>f()},'react/jsx-runtime':{jsx,jsxs:jsx},'react-router-dom':{Link:'link'},'../app/WorkspaceContext':{useWorkspace:()=>scope},'../auth/AuthContext':{useAuth:()=>({desktop:{}})},'../lib/apiError':{apiErrorMessage:()=> '접근 권한 없음'}}
function load(file, modules) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>modules[name]??(name.endsWith('/design/ui')?designUi:{})})
  return exports
}
const agents = load('components/AgentSettings.tsx',{...base,'../lib/executionAgentSelection':load('lib/executionAgentSelection.ts',{})})
let list = {isSuccess:true,data:[{id:'wire',name:'전문'}]}, detail = {}, queries = []
const panel = load('panels/TcpNodePanel.tsx',{...base,'../components/AgentSettings':agents,'@tanstack/react-query':{useQuery:q=>{queries.push(q);return q.queryKey.at(-1)==='protocols'?list:detail}}})
const node = {type:'tcp',executionAgent:'server',protocolId:'wire',tcpValues:{amount:'keep'}}
const render = () => { queries=[];return panel.TcpRequestPanel({node,update(){},sources:[],canEdit:true,preview:null,previewErr:null,onPreview(){}}) }
function walk(n, pred, out=[]) {if(Array.isArray(n)) n.forEach(x=>walk(x,pred,out));else if(n&&typeof n==='object'){if(pred(n))out.push(n);walk(n.props?.children,pred,out)}return out}
const text = n=>Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):typeof n==='string'?n:''
const select = tree=>walk(tree,n=>n.type==='select'&&n.props['aria-label']==='프로토콜')[0]
let tree = render()
assert.equal(queries[0].queryFn(),'server:team');assert.match(text(tree),/서버 · 개발팀/);assert.equal(select(tree).props.disabled,false)
node.executionAgent='local';tree=render();assert.equal(queries[0].queryFn(),'local:pc');assert.match(text(tree),/내 PC · 개인 공간/)
list={isSuccess:true,data:[]};detail={isError:true,error:{}};tree=render();assert.match(text(tree),/기존 프로토콜이 이 실행 위치의 공간에 없습니다/);assert.doesNotMatch(text(tree),/접근 권한 없음/);assert.equal(walk(tree,n=>n.type==='link')[0].props.to,'/protocols?space=local%3Apc');assert.equal(select(tree).props.value,'wire');assert.equal(node.tcpValues.amount,'keep');detail={}
list={isPending:true};tree=render();assert.equal(select(tree).props.disabled,true);assert.match(text(tree),/불러오는 중/)
list={isError:true,error:{}};tree=render();assert.match(text(tree),/접근 권한 없음/);assert.equal(select(tree).props.disabled,true)
node.executionAgent='server';scope.connected=false;tree=render();assert.equal(queries[0].enabled,false);assert.match(text(tree),/서버에 로그인/);assert.equal(select(tree).props.disabled,true)
console.log('PASS: TCP protocol storage follows execution location; missing selection and field values preserved; pending/error/offline explicit')
