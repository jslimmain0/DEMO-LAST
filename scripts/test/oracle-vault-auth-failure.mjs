import{spawnSync}from'node:child_process';import assert from'node:assert/strict';
const r=spawnSync('docker',['compose','--env-file','.run/oracle-vault/infra.env','-f','infra/oracle-vault-test.compose.yml','run','--rm','--no-deps','-e','FLOWLINK_VAULT_APPROLE_ROLE_ID=invalid-lab-role','--entrypoint','java','server','-jar','/app/flowlink.jar'],{encoding:'utf8',timeout:45000});
assert.notEqual(r.status,0);assert.ok((r.stdout+r.stderr).includes('invalid role or secret ID'));console.log('PASS real AppRole invalid credentials fail application startup');
