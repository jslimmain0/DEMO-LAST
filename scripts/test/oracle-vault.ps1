param([switch]$Initialize)
$ErrorActionPreference='Stop'
Set-Location (Join-Path $PSScriptRoot '../..')
$compose=@('compose','--env-file','.run/oracle-vault/infra.env','-f','infra/oracle-vault-test.compose.yml')
New-Item -ItemType Directory -Force .run/oracle-vault | Out-Null
if($Initialize){
  if(Test-Path .run/oracle-vault/infra.env){throw '이미 존재하는 격리 실험입니다. 새 초기화는 별도 볼륨/프로젝트를 사용하세요.'}
  @('LAB_ORACLE_ADMIN_PASSWORD','LAB_ORACLE_PASSWORD','LAB_VAULT_TOKEN') | ForEach-Object { $_+'=a'+[Guid]::NewGuid().ToString('N') } | Set-Content -Encoding utf8 .run/oracle-vault/infra.env
  '' | Set-Content .run/oracle-vault/server.env
}
if(!(Test-Path .run/oracle-vault/infra.env)){throw '-Initialize 로 격리 서비스를 먼저 준비하세요.'}
& docker @compose up -d oracle vault
if($LASTEXITCODE){throw 'Docker 기동 실패'}
for($i=0;$i -lt 120;$i++){
 $health=& docker inspect -f '{{.State.Health.Status}}' flowlink-oracle-vault-test-oracle-1
 if($health -eq 'healthy'){break}
 if($i -eq 119){throw 'Oracle 준비 시간 초과'}
 Write-Host 'Oracle 실제 DB 준비 대기...'; Start-Sleep -Seconds 5
}
if($Initialize){node scripts/test/oracle-vault-setup.mjs --schema}else{node scripts/test/oracle-vault-setup.mjs}
if($LASTEXITCODE){throw 'Schema/Vault 설정 실패'}
& docker build -f infra/agent-test.Dockerfile -t flowlink-oracle-vault-test .
if($LASTEXITCODE){throw '최신 :server-app:bootJar 기반 image 빌드 실패'}
& docker @compose up -d --force-recreate server
if($LASTEXITCODE){throw 'Oracle/Vault 앱 기동 실패'}
node scripts/test/oracle-vault.mjs
if($LASTEXITCODE){throw 'Oracle/Vault 검증 실패'}
$env:FLOWLINK_URL='http://127.0.0.1:18183'
$env:FLOWLINK_TOKEN=Get-Content .run/oracle-vault/token.txt -Raw
$env:FLOWLINK_WORKSPACE_ID=(Get-Content .run/oracle-vault/results.json | ConvertFrom-Json).workspaceId
node scripts/test/oracle-vault-auth-failure.mjs
if($LASTEXITCODE){throw 'AppRole 실패 검증 실패'}
$env:FLOWLINK_TEST_OUTPUT_DIR='.run/oracle-vault'
node --experimental-strip-types scripts/test/rest-features.ts
if($LASTEXITCODE){throw 'Oracle 기존기능 회귀 검증 실패'}
