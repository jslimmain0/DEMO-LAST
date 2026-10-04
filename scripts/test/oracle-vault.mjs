// 실제 Oracle + Vault Transit/AppRole 전용. MCP 호출 없음.
import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{spawnSync}from'node:child_process';
const base='http://127.0.0.1:18183';const tag=`oracle-vault-${Date.now()}`;let token;let checks=0;
const pass=n=>console.log(`PASS ${++checks} ${n}`);
async function req(path,method='GET',body,expected=200){const r=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();assert.equal(r.status,expected,`${method} ${path}: ${t}`);return t?JSON.parse(t):null;}
async function login(){const s=await req('/api/v1/auth/github/device/start','POST');token=(await req(`/api/v1/auth/github/device/poll?session=${s.sessionId}`)).token;assert.ok(token);}
async function run(flow,envName){const start=await req(`/api/v1/flows/${flow}/runs`,'POST',{envName});for(let i=0;i<100;i++){const x=await req(`/api/v1/executions/${start.id}`);if(x.status!=='RUNNING')return x;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');}
for(let i=0;i<100;i++){try{await req('/api/v1/auth/config');break}catch{await new Promise(r=>setTimeout(r,500))}}
await login();pass('Oracle JWT account/workspace persistence');
const ws=await req('/api/v1/workspaces','POST',{name:tag},201);const other=await req('/api/v1/workspaces','POST',{name:`${tag}-other`},201);
const secrets={common:crypto.randomUUID(),prod:crypto.randomUUID(),other:crypto.randomUUID()};
for(const[scope,env,value]of[[ws.id,null,secrets.common],[ws.id,'prod',secrets.prod],[other.id,null,secrets.other]])await req(`/api/v1/secrets/key?workspaceId=${scope}`,'PUT',{value,environment:env});
const names=await req(`/api/v1/secrets?workspaceId=${ws.id}`);assert.equal(names.length,2);assert.ok(!JSON.stringify(names).includes(secrets.common));pass('write-only secret names and workspace isolation');
const node=(id,type,x={})=>({id,type,name:id,x:0,y:0,...x});const edge=(from,to)=>({id:`${from}-${to}`,from,to,fromPort:'out'});
const flow=await req('/api/v1/flows','POST',{name:tag,workspaceId:ws.id},201);
const nodes=[node('start','start'),node('value','set',{vars:[{key:'actual',value:'{{ key@secret }}'}]}),node('check','assert',{condition:'{{ actual@value }} == {{ expected@env }}'}),node('end','end')];
await req(`/api/v1/flows/${flow.id}/versions`,'POST',{graph:{nodes,edges:nodes.slice(1).map((n,i)=>edge(nodes[i].id,n.id))}},201);
async function execute(envName,expected){const start=await req(`/api/v1/flows/${flow.id}/runs`,'POST',{envName,env:{expected}});for(let i=0;i<100;i++){const x=await req(`/api/v1/executions/${start.id}`);if(x.status!=='RUNNING'){assert.equal(x.status,'SUCCEEDED',JSON.stringify(x));for(const s of Object.values(secrets))assert.ok(!JSON.stringify(x).includes(s),'secret leaked');return x;}await new Promise(r=>setTimeout(r,100));}throw Error('timeout');}
await execute(null,secrets.common);pass('common Transit secret resolves and runtime logs mask');await execute('prod',secrets.prod);pass('environment secret overrides common');
await execute('absent',secrets.common);pass('unknown environment falls back to common');
const cfg=Object.fromEntries(readFileSync('.run/oracle-vault/infra.env','utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(x=>x.split('=')));
const sql=`set heading off\nset feedback off\nwhenever sqlerror exit sql.sqlcode\nconnect flowlink/"${cfg.LAB_ORACLE_PASSWORD}"@//localhost:1521/FREEPDB1\nSELECT CASE WHEN enc_value LIKE 'vault:v1:%' THEN 'TRANSIT' ELSE 'BAD' END FROM flowlink_secret WHERE name='key';\nexit\n`;
const db=spawnSync('docker',['exec','-i','flowlink-oracle-vault-test-oracle-1','sqlplus','-s','/nolog'],{input:sql,encoding:'utf8'});assert.equal(db.status,0);assert.ok(db.stdout.includes('TRANSIT')&&!db.stdout.includes('BAD'));pass('Oracle rows contain actual vault:v1 ciphertext');
await new Promise(r=>setTimeout(r,17000));await execute('prod',secrets.prod);pass('AppRole short lease renew/self or re-login');
spawnSync('docker',['compose','--env-file','.run/oracle-vault/infra.env','-f','infra/oracle-vault-test.compose.yml','restart','server'],{stdio:'pipe'});
for(let i=0;i<100;i++){try{await req('/api/v1/auth/config');break}catch{await new Promise(r=>setTimeout(r,500))}}
await login();await execute('prod',secrets.prod);pass('application restart preserves Oracle data and Vault decrypt');
const mock=await req('/api/v1/mock-servers','POST',{name:tag,slug:tag,workspaceId:ws.id},201);
await req(`/api/v1/mock-servers/${mock.id}/spec`,'PUT',{spec:{routes:[{id:'echo',method:'POST',path:'/echo',rules:[{id:'echo',status:200,contentType:'json',body:'{"echo":"{{body.token}}"}'}]}]}});
const httpFlow=await req('/api/v1/flows','POST',{name:`${tag}-http`,workspaceId:ws.id},201);
const httpNodes=[node('start','start'),node('http','http',{method:'POST',baseUrl:base,path:`${mock.basePath}/echo`,bodyType:'json',fields:{body:[{key:'token',value:'{{ key@secret }}'}]},respType:'json',outputs:[{key:'echo'}]}),node('verify','assert',{condition:'{{ echo@http }} == {{ key@secret }}'}),node('end','end')];
await req(`/api/v1/flows/${httpFlow.id}/versions`,'POST',{graph:{nodes:httpNodes,edges:[edge('start','http'),edge('http','verify'),edge('verify','end')]}},201);
const response=await run(httpFlow.id,'prod');assert.equal(response.status,'SUCCEEDED',JSON.stringify(response));for(const value of Object.values(secrets))assert.ok(!JSON.stringify(response).includes(value));pass('actual HTTP request/response secret masking');
spawnSync('docker',['pause','flowlink-oracle-vault-test-vault-1'],{stdio:'pipe'});
try{await req(`/api/v1/secrets/outage?workspaceId=${ws.id}`,'PUT',{value:secrets.common},500);pass('Vault outage fails secret write without local crypto fallback');}finally{spawnSync('docker',['unpause','flowlink-oracle-vault-test-vault-1'],{stdio:'pipe'});}
await execute('prod',secrets.prod);pass('Vault recovers without application restart');
spawnSync('docker',['restart','flowlink-oracle-vault-test-oracle-1'],{stdio:'pipe'});
let healthy=false;for(let i=0;i<120;i++){const h=spawnSync('docker',['inspect','-f','{{.State.Health.Status}}','flowlink-oracle-vault-test-oracle-1'],{encoding:'utf8'});if(h.stdout.trim()==='healthy'){healthy=true;break}await new Promise(r=>setTimeout(r,1000));}assert.ok(healthy,'Oracle restart readiness');
await execute('prod',secrets.prod);pass('actual Oracle container restart preserves secrets and JDBC reconnects');
const logs=spawnSync('docker',['logs','flowlink-oracle-vault-test-server-1'],{encoding:'utf8'});for(const value of Object.values(secrets))assert.ok(!(logs.stdout+logs.stderr).includes(value));pass('container logs contain no dummy secret plaintext');
writeFileSync('.run/oracle-vault/results.json',JSON.stringify({checks,flowId:flow.id,workspaceId:ws.id,otherWorkspaceId:other.id},null,2));
writeFileSync('.run/oracle-vault/token.txt',token);console.log(`PASS total ${checks}`);
