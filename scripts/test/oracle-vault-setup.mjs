// 격리 Oracle/Vault 실서비스 준비. 자격증명은 .run 아래만 저장하고 출력하지 않는다.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const cfg=Object.fromEntries(readFileSync('.run/oracle-vault/infra.env','utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(x=>x.split('=')));
const vault='http://127.0.0.1:18200/v1/';
async function v(path,body){const r=await fetch(vault+path,{method:body===undefined?'GET':'POST',headers:{'X-Vault-Token':cfg.LAB_VAULT_TOKEN,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error(`Vault ${path}: ${r.status}`);return r.status===204?{}:r.json()}
function sql(user,password,body){const input=`set echo off\nset feedback off\nwhenever sqlerror exit sql.sqlcode\nconnect ${user}/"${password}"@//localhost:1521/FREEPDB1\n${body}\nexit\n`;const r=spawnSync('docker',['exec','-i','flowlink-oracle-vault-test-oracle-1','sqlplus','-s','/nolog'],{input,encoding:'utf8'});if(r.status!==0)throw Error((r.stdout+r.stderr).replaceAll(password,"[redacted]"));return r.stdout;}
if(process.argv.includes('--schema')){
 console.log(sql('flowlink',cfg.LAB_ORACLE_PASSWORD,readFileSync('backend/runtime/src/main/resources/db/init.sql','utf8')));
}
if(process.argv.includes('--upgrade') || process.argv.includes('--schema')){
 // 별도 사용자에서 기존 release schema + 세 업그레이드를 실행한다. 신규 schema와 혼합하지 않는다.
 sql('system',cfg.LAB_ORACLE_ADMIN_PASSWORD,`CREATE USER flowlink_upgrade IDENTIFIED BY "${cfg.LAB_ORACLE_PASSWORD}";\nGRANT CONNECT, RESOURCE, UNLIMITED TABLESPACE TO flowlink_upgrade;`);
 const old=spawnSync('git',['show','HEAD:backend/src/main/resources/db/init.sql'],{encoding:'utf8'});if(old.status!==0)throw Error('Legacy schema unavailable');
 sql('flowlink_upgrade',cfg.LAB_ORACLE_PASSWORD,old.stdout);
 for(const name of ['agent-execution','agent-tasks','workspace-resources'])sql('flowlink_upgrade',cfg.LAB_ORACLE_PASSWORD,readFileSync(`backend/runtime/src/main/resources/db/upgrade-${name}.sql`,'utf8'));
 const count=sql('flowlink_upgrade',cfg.LAB_ORACLE_PASSWORD,`SELECT COUNT(*) FROM user_tables WHERE table_name IN ('FLOWLINK_AGENT_TASK','FLOWLINK_WAIT_CALLBACK');`);
  if(!count.includes('2'))throw Error('upgrade tables missing');
 const differences=sql('system',cfg.LAB_ORACLE_ADMIN_PASSWORD,`set heading off
 SELECT COUNT(*) FROM (
 (SELECT table_name,column_name,data_type FROM all_tab_columns WHERE owner='FLOWLINK' AND table_name LIKE 'FLOWLINK_%'
 MINUS SELECT table_name,column_name,data_type FROM all_tab_columns WHERE owner='FLOWLINK_UPGRADE' AND table_name LIKE 'FLOWLINK_%')
 UNION ALL
 (SELECT table_name,column_name,data_type FROM all_tab_columns WHERE owner='FLOWLINK_UPGRADE' AND table_name LIKE 'FLOWLINK_%'
 MINUS SELECT table_name,column_name,data_type FROM all_tab_columns WHERE owner='FLOWLINK' AND table_name LIKE 'FLOWLINK_%'));
 `);if(differences.trim()!=='0')throw Error('fresh/upgrade column schema differs');
 console.log('PASS Oracle init + legacy three upgrades; all table/column/type sets match');
}
const mounts=await v('sys/mounts');if(!mounts['transit/'])await v('sys/mounts/transit',{type:'transit'});
await v('transit/keys/flowlink',{});
const auth=await v('sys/auth');if(!auth['approle/'])await v('sys/auth/approle',{type:'approle'});
await v('sys/policies/acl/flowlink-test',{policy:'path "transit/encrypt/flowlink" { capabilities = ["update"] }\npath "transit/decrypt/flowlink" { capabilities = ["update"] }'});
await v('auth/approle/role/flowlink-test',{token_policies:['flowlink-test'],token_ttl:'30s',token_max_ttl:'60s'});
const role=await v('auth/approle/role/flowlink-test/role-id');const secret=await v('auth/approle/role/flowlink-test/secret-id',{});
writeFileSync('.run/oracle-vault/server.env',`FLOWLINK_VAULT_APPROLE_ROLE_ID=${role.data.role_id}\nFLOWLINK_VAULT_APPROLE_SECRET_ID=${secret.data.secret_id}\n`);
console.log('PASS actual Vault Transit + least privilege AppRole prepared (30s TTL)');
