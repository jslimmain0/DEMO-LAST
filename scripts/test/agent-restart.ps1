# Isolated native runtime + Docker server durability. REST only; no MCP calls.
param(
  [Parameter(Mandatory=$true)][string]$DataDir,
  [Parameter(Mandatory=$true)][string]$Jar,
  [Parameter(Mandatory=$true)][string]$Bundle,
  [Parameter(Mandatory=$true)][string]$JdkPath
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$DataDir = (Resolve-Path -LiteralPath $DataDir).Path
$ExpectedRoot = (Resolve-Path -LiteralPath (Join-Path $Repo '.run/agent-lab')).Path + '\'
if (-not $DataDir.StartsWith($ExpectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Use a disposable agent-lab data directory.' }
$AgentFile = Join-Path $DataDir 'agent.json'
$Agent = Get-Content -LiteralPath $AgentFile -Raw | ConvertFrom-Json
$BeforeAgent = $Agent
$BeforeKey = (Get-FileHash (Join-Path $DataDir 'storage.key')).Hash
$Fixtures = Get-Content (Join-Path $DataDir 'storage-fixtures.json') -Raw | ConvertFrom-Json
$Checks = 0
function Check($Value, $Name) { if (-not $Value) { throw "FAIL: $Name" }; $script:Checks++; Write-Output "PASS $script:Checks $Name" }
function Api($Path, $Method='GET', $Body=$null) {
  $Request = @{Uri=($Agent.baseUrl+$Path); Method=$Method; Headers=@{'X-FlowLink-Local'=$Agent.token}; UseBasicParsing=$true}
  if ($null -ne $Body) {$Request.ContentType='application/json'; $Request.Body=$Body | ConvertTo-Json -Depth 20 -Compress}
  $Response = Invoke-WebRequest @Request
  if ($Response.Content) { $Response.Content | ConvertFrom-Json }
}
function Until($Path, $Expected) {
  for($Attempt=0; $Attempt -lt 150; $Attempt++) { $Detail=Api $Path; if($Detail.status -eq $Expected){return $Detail}; if($Detail.status -eq 'FAILED'){throw 'Durability workflow failed'}; Start-Sleep -Milliseconds 200 }
  throw "Timed out waiting for $Expected"
}
$Tag = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$EnvName = "restart-$Tag"
$SecretName = "restart-key-$Tag"
$Runs = @()
foreach($Runtime in @('local','server')) {
  $Prefix = if($Runtime -eq 'local') {'/api/v1'} else {'/api/v1/remote'}
  $Marker = $Runtime.ToUpperInvariant()
  $null=Api "$Prefix/environments/$EnvName" 'PUT' @{vars=@{origin=$Marker}}
  $null=Api "$Prefix/secrets/$SecretName" 'PUT' @{value="test-$Marker"; environment=$EnvName}
  $Body=@{name="restart-$Runtime-$Tag"}
  if($Runtime -eq 'server') {$Body.workspaceId=$Fixtures.teamWorkspace}
  $Flow=Api "$Prefix/flows" 'POST' $Body
  $Graph=@{nodes=@(@{id='s';type='start'},@{id='env';type='assert';condition="{{ origin@env }} == '$Marker'"},@{id='secret';type='assert';condition="{{ $SecretName@secret }} == 'test-$Marker'"},@{id='w';type='wait';waitTimeoutSec=300;callbackRespType='text';callbackRespBody='RESTORED'},@{id='e';type='end'});edges=@(@{id='a';from='s';to='env'},@{id='b';from='env';to='secret'},@{id='c';from='secret';to='w'},@{id='d';from='w';to='e'})}
  $null=Api "$Prefix/flows/$($Flow.id)/versions" 'POST' @{graph=$Graph}
  $EnvironmentList=Api "$Prefix/environments"
  $Environment=$EnvironmentList | Where-Object name -eq $EnvName
  $Run=Api "$Prefix/flows/$($Flow.id)/runs" 'POST' @{envName=$EnvName;env=$Environment.vars}
  $Run=Until "$Prefix/executions/$($Run.id)" 'WAITING'
  $Runs+=@{prefix=$Prefix;id=$Run.id;flowId=$Flow.id;callback=$Run.pendingWait.receiveUrl}
  Check $true "$Runtime uses its own environment and encrypted secret"
}
$null=Api '/desktop/shutdown' 'POST'
for($Attempt=0; $Attempt -lt 30; $Attempt++) { Start-Sleep -Milliseconds 200; try{$null=Api '/api/v1/desktop/connection'}catch{break} }
$Args=@('-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT',"-Dflowlink.bundle.dir=$((Resolve-Path -LiteralPath $Bundle).Path)",'-jar',(Resolve-Path -LiteralPath $Jar).Path,'--spring.profiles.active=local,desktop',"--server.port=$(([uri]$BeforeAgent.baseUrl).Port)","--flowlink.desktop.data-dir=$DataDir",'--flowlink.desktop.tray=false','--flowlink.desktop.open-browser=false')
$Process=Start-Process -FilePath (Join-Path $JdkPath 'bin/java.exe') -ArgumentList $Args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $DataDir 'restart.out.log') -RedirectStandardError (Join-Path $DataDir 'restart.err.log')
$Process.Id | Set-Content (Join-Path $DataDir 'preview.pid')
for($Attempt=0; $Attempt -lt 150; $Attempt++) {
  Start-Sleep -Milliseconds 200
  try{$Agent=Get-Content $AgentFile -Raw | ConvertFrom-Json; if($Agent.token -ne $BeforeAgent.token){$null=Api '/api/v1/desktop/connection'; break}}catch{}
}
Check ($Agent.token -ne $BeforeAgent.token -and $Agent.deviceId -eq $BeforeAgent.deviceId -and (Get-FileHash (Join-Path $DataDir 'storage.key')).Hash -eq $BeforeKey) 'native restart preserves device and key, rotates local access'
Check ((Api '/api/v1/desktop/connection').connected) 'app server login survives native restart'
& docker compose -f (Join-Path $Repo 'infra/agent-lab.compose.yml') restart server
if($LASTEXITCODE -ne 0){throw 'Docker restart failed'}
for($Attempt=0; $Attempt -lt 200; $Attempt++) { Start-Sleep -Milliseconds 200; try{$null=Api '/api/v1/remote/workspaces';break}catch{} }
Check ((Api "/api/v1/remote/flows/$($Fixtures.teamFlow)").id -eq $Fixtures.teamFlow) 'remote team survives Docker restart'
Check ((Api "/api/v1/remote/executions/$($Fixtures.executionId)").status -eq 'SUCCEEDED') 'remote execution history survives Docker restart'
foreach($Run in $Runs) {
  $Restored=Api "$($Run.prefix)/executions/$($Run.id)"
  Check ($Restored.status -eq 'WAITING' -and $Restored.pendingWait.nodeId -eq 'w') "$($Run.prefix) restores persisted wait"
  $Response=Invoke-WebRequest -Uri $Run.callback -Method Post -Body '{}' -ContentType 'application/json' -UseBasicParsing
  Check ($Response.Content -eq 'RESTORED') 'restored callback keeps response contract'
  $null=Until "$($Run.prefix)/executions/$($Run.id)" 'SUCCEEDED'
  Check $true 'restored wait resumes to completion'
  $EnvironmentList=Api "$($Run.prefix)/environments"
  $Environment=$EnvironmentList | Where-Object name -eq $EnvName
  $Next=Api "$($Run.prefix)/flows/$($Run.flowId)/runs" 'POST' @{envName=$EnvName;env=$Environment.vars}
  $Next=Until "$($Run.prefix)/executions/$($Next.id)" 'WAITING'
  $null=Api "$($Run.prefix)/executions/$($Next.id)/resume" 'POST' @{nodeId='w';aborted=$true}
  $null=Until "$($Run.prefix)/executions/$($Next.id)" 'CANCELLED'
  Check $true 'environment and encrypted secret still execute after restart'
}
@{checks=$Checks;envName=$EnvName;secretName=$SecretName;runs=$Runs} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $DataDir 'restart-results.json') -Encoding utf8
Write-Output "ALL $Checks PASS"
