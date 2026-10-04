# Actual native process / Docker restart checks. REST only; no MCP/IDE probes.
param([Parameter(Mandatory=$true)][string]$AgentFile,
  [string]$JdkPath='C:\Users\jslim\.jdks\corretto-21.0.10')
$ErrorActionPreference='Stop'
$Repo=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Data=(Resolve-Path (Split-Path -Parent $AgentFile)).Path
$Expected=(Resolve-Path (Join-Path $Repo '.run/agent-lab')).Path+'\'
if(-not $Data.StartsWith($Expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Use a disposable agent-lab data directory.'}
$AgentFile=Join-Path $Data 'agent.json'
$Agent=Get-Content -LiteralPath $AgentFile -Raw|ConvertFrom-Json
$Fixtures=Get-Content -LiteralPath (Join-Path $Data 'hybrid-fixtures.json') -Raw|ConvertFrom-Json
$Tag='resume-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$Checks=0
function Check($C,$N){if(-not $C){throw "FAIL: $N"};$script:Checks++;Write-Output "PASS $script:Checks $N"}
function Api($Path,$Method='GET',$Body=$null){
  $Args=@{Uri=$Agent.baseUrl+$Path;Method=$Method;Headers=@{'X-FlowLink-Local'=$Agent.token};UseBasicParsing=$true}
  if($null -ne $Body){$Args.ContentType='application/json';$Args.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 30 -Compress))}
  $R=Invoke-WebRequest @Args;if($R.Content){$R.Content|ConvertFrom-Json}
}
function Wait-Run($Prefix,$Id,$State){
  for($I=0;$I -lt 200;$I++){
    $R=Api "$Prefix/executions/$Id"
    if($R.status -eq $State -or ($State -eq 'UNKNOWN' -and $R.pendingAgent.status -eq 'UNKNOWN')){return $R}
    if($R.status -eq 'FAILED'){throw "Execution failed: $($R.error)"}
    Start-Sleep -Milliseconds 150
  };throw "Run $Id did not reach $State"
}
function Flow($Prefix,$Space,$Middle){
  $N=@(@{id='s';type='start'})+@($Middle)+@(@{id='e';type='end'});$E=@()
  for($I=1;$I -lt $N.Count;$I++){$E+=@{id="e$I";from=$N[$I-1].id;to=$N[$I].id}}
  $F=Api "$Prefix/flows" 'POST' @{name=$Tag;workspaceId=$Space}
  $null=Api "$Prefix/flows/$($F.id)/versions" 'POST' @{graph=@{nodes=$N;edges=$E}}
  return $F
}
function Restart-Desktop {
  $Before=$script:Agent;$Key=(Get-FileHash (Join-Path $Data 'storage.key')).Hash
  $Process=Get-Process -Id ([int](Get-Content (Join-Path $Data 'preview.pid'))) -ErrorAction Stop
  $null=Api '/desktop/shutdown' 'POST'
  if(-not $Process.WaitForExit(30000)){throw 'Native preview did not stop safely.'}
  $Jar=(Resolve-Path (Join-Path $Repo 'backend/desktop-app/build/libs/flowlink-desktop.jar')).Path
  $Bundle=(Resolve-Path (Join-Path $Repo '.run/agent-lab/preview-bundle')).Path
  $Args=@('-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT',"-Dflowlink.bundle.dir=$Bundle",'-jar',$Jar,'--spring.profiles.active=local,desktop',"--server.port=$(([uri]$Before.baseUrl).Port)","--flowlink.desktop.data-dir=$Data",'--flowlink.desktop.tray=false','--flowlink.desktop.open-browser=false')
  $P=Start-Process -FilePath (Join-Path $JdkPath 'bin/java.exe') -ArgumentList $Args -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Data 'hybrid-restart.out.log') -RedirectStandardError (Join-Path $Data 'hybrid-restart.err.log')
  $P.Id|Set-Content (Join-Path $Data 'preview.pid')
  for($I=0;$I -lt 180;$I++){
    Start-Sleep -Milliseconds 200
    try{$script:Agent=Get-Content $AgentFile -Raw|ConvertFrom-Json;if($Agent.token -ne $Before.token){$null=Api '/api/v1/desktop/connection';break}}catch{}
  }
  Check ($Agent.token -ne $Before.token -and $Agent.deviceId -eq $Before.deviceId -and (Get-FileHash (Join-Path $Data 'storage.key')).Hash -eq $Key) 'Native restart keeps device, H2 key and rotates local access'
}

$Runs=@()
foreach($Origin in @('local','server')){
  $Prefix=if($Origin -eq 'local'){'/api/v1'}else{'/api/v1/remote'}
  $Space=if($Origin -eq 'local'){$Fixtures.personalWorkspace}else{$Fixtures.teamWorkspace}
  $F=Flow $Prefix $Space @(
    @{id='gate';type='input';waitFields=@(@{key='go';type='string'})},
    @{id='pc';type='set';executionAgent='local';vars=@(@{key='marker';value='PC'})},
    @{id='server';type='set';executionAgent='server';agentWorkspaceId=$Fixtures.teamWorkspace;vars=@(@{key='marker';value='SERVER'})},
    @{id='check';type='assert';executionAgent='local';condition="{{ marker@pc }} == 'PC' && {{ marker@server }} == 'SERVER'"})
  $R=Api "$Prefix/flows/$($F.id)/runs" 'POST' @{}
  Check ($R.pendingInput.nodeId -eq 'gate') "$Origin persisted the hybrid checkpoint before restart"
  $Runs+=@{prefix=$Prefix;id=$R.id}
}
Restart-Desktop
& docker compose -f (Join-Path $Repo 'infra/agent-lab.compose.yml') restart server
if($LASTEXITCODE -ne 0){throw 'Docker restart failed'}
for($I=0;$I -lt 200;$I++){Start-Sleep -Milliseconds 200;try{$null=Api '/api/v1/remote/workspaces';break}catch{}}
Check ((Api '/api/v1/desktop/connection').connected) 'Server login survives native and Docker restart'
foreach($R in $Runs){
  $Restored=Api "$($R.prefix)/executions/$($R.id)"
  Check ($Restored.pendingInput.nodeId -eq 'gate') "$($R.prefix) restored the same checkpoint"
  $null=Api "$($R.prefix)/executions/$($R.id)/resume" 'POST' @{nodeId='gate';formValues=@{go='yes'}}
  $Done=Wait-Run $R.prefix $R.id 'SUCCEEDED'
  Check ($Done.id -eq $R.id -and @($Done.nodes|Where-Object nodeId -eq 'pc').Count -eq 1) "$($R.prefix) completed PC-server-PC once under the original execution ID"
}

# Interrupt native I/O while its target Mock remains alive on the server.
$M=Api '/api/v1/remote/mock-servers' 'POST' @{name=$Tag;slug=$Tag;workspaceId=$Fixtures.teamWorkspace;type='HTTP'}
$null=Api "/api/v1/remote/mock-servers/$($M.id)/spec" 'PUT' @{spec=@{routes=@(@{id='slow';method='POST';path='/slow';rules=@(@{id='slow';status=200;contentType='json';body='{"ok":true}';delayMs=10000})})}}
$Base=(Api '/api/v1/desktop/connection').serverUrl
$F=Flow '/api/v1/remote' $Fixtures.teamWorkspace @(@{id='slow';type='http';executionAgent='local';method='POST';baseUrl=($Base+$M.basePath);path='/slow';respType='json';agentOutputs=@('ok')})
$R=Api "/api/v1/remote/flows/$($F.id)/runs" 'POST' @{}
$Observed=$false
for($I=0;$I -lt 100;$I++){
  $Journal=@(Api '/api/v1/desktop/dispatches'|Where-Object executionId -eq $R.id)
  $Requests=@(Api "/api/v1/remote/mock-servers/$($M.id)/requests")
  if($Journal.phase -eq 'EXECUTING' -and $Requests.Count -eq 1){$Observed=$true;break};Start-Sleep -Milliseconds 50
}
Check $Observed 'A single native request reached the remote Mock before interruption'
Restart-Desktop
$Unknown=Wait-Run '/api/v1/remote' $R.id 'UNKNOWN'
Check ($Unknown.status -eq 'WAITING') 'Interrupted external request stays UNKNOWN instead of replaying'
Check (@(Api "/api/v1/remote/mock-servers/$($M.id)/requests").Count -eq 1) 'Restart did not issue the external request twice'
$null=Api "/api/v1/remote/executions/$($R.id)/resume" 'POST' @{nodeId='slow';aborted=$true}
Check ((Wait-Run '/api/v1/remote' $R.id 'CANCELLED').status -eq 'CANCELLED') 'User can cancel the uncertain run without a duplicate call'
@{checks=$Checks;runs=$Runs;unknownExecution=$R.id}|ConvertTo-Json -Depth 6|Set-Content (Join-Path $Data 'hybrid-restart-results.json') -Encoding UTF8
Write-Output "ALL $Checks RESTART CHECKS PASS"
