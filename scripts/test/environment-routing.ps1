# Two native PC stores and one Docker server execute the identical shared graph.
# Only isolated lab runtimes; no MCP or IDE calls.
param([Parameter(Mandatory=$true)][string]$AgentFile,[Parameter(Mandatory=$true)][string]$SecondAgentFile)
$ErrorActionPreference='Stop'
$Agents=@((Get-Content -Raw -LiteralPath $AgentFile|ConvertFrom-Json),(Get-Content -Raw -LiteralPath $SecondAgentFile|ConvertFrom-Json))
if($Agents[0].baseUrl -ne 'http://127.0.0.1:18182' -or $Agents[1].baseUrl -ne 'http://127.0.0.1:18186'){throw 'Only isolated PC fixtures 18182 and 18186 are allowed.'}
$Tag='environment-routing-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Checks=0
function Check($Condition,$Name){if(-not $Condition){throw "FAIL: $Name"};$script:Checks++;Write-Output "PASS $script:Checks $Name"}
function Api($Index,$Path,$Method='GET',$Body=$null,$Extra=@{}){
  $Headers=@{'X-FlowLink-Local'=$Agents[$Index].token};foreach($Key in $Extra.Keys){$Headers[$Key]=$Extra[$Key]}
  $Args=@{Uri=$Agents[$Index].baseUrl+$Path;Method=$Method;Headers=$Headers;UseBasicParsing=$true}
  if($null -ne $Body){$Args.ContentType='application/json; charset=utf-8';$Args.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 60 -Compress))}
  $Response=Invoke-WebRequest @Args
  if($Response.Content){return $Response.Content|ConvertFrom-Json}
}
function WaitRun($Index,$Id){
  $Until=[DateTime]::UtcNow.AddSeconds(60)
  do{$Run=Api $Index "/api/v1/remote/executions/$Id";if($Run.status -in @('FAILED','SUCCEEDED','CANCELLED')){return $Run};Start-Sleep -Milliseconds 150}while([DateTime]::UtcNow -lt $Until)
  throw 'Execution did not finish.'
}
function PrepareTarget($Index,$Prefix,$Workspace,$Env,$Marker,$Base){
  $Mock=Api $Index "$Prefix/mock-servers" 'POST' @{name="$Tag $Marker";slug=$Tag;type='HTTP';workspaceId=$Workspace}
  $Key='fixture-'+$Marker+'-'+[guid]::NewGuid().ToString('N')
  $null=Api $Index "$Prefix/environments/$Env`?workspaceId=$Workspace" 'PUT' @{vars=@{PAYMENT_BASE_URL=($Base+$Mock.basePath);marker=$Marker}}
  $null=Api $Index "$Prefix/secrets/API_KEY`?workspaceId=$Workspace" 'PUT' @{environment=$Env;value=$Key}
  $null=Api $Index "$Prefix/mock-servers/$($Mock.id)/spec" 'PUT' @{spec=@{environment=$Env;routes=@(@{id='probe';method='GET';path='/probe';rules=@(
    @{id='ok';when=@(@{source='header';key='x-api-key';op='eq';value='{{API_KEY@secret}}'});status=200;contentType='json';body=('{"origin":"'+$Marker+'"}')},
    @{id='bad';status=401;contentType='json';body='{"error":"wrong environment"}'})})}}
  return @{mockId=$Mock.id;secret=$Key;url=$Base+$Mock.basePath}
}
for($I=0;$I -lt 2;$I++){
  $null=Api $I '/api/v1/desktop/connection' 'PUT' @{serverUrl='http://127.0.0.1:18080'}
  if(-not (Api $I '/api/v1/desktop/connection').connected){
    $Started=Api $I '/api/v1/desktop/login/start' 'POST' @{}
    if($Started.userCode -ne 'MOCK-LOGIN'){throw 'Only lab mock login is allowed.'}
    $null=Api $I '/api/v1/desktop/login/poll'
  }
}
$PersonalA=(Api 0 '/api/v1/workspaces') | ForEach-Object { $_ } | Where-Object kind -eq PERSONAL | Select-Object -First 1
$PersonalB=(Api 1 '/api/v1/workspaces') | ForEach-Object { $_ } | Where-Object kind -eq PERSONAL | Select-Object -First 1
Check ($PersonalA.id -ne $PersonalB.id) 'The two PCs own different personal H2 workspaces'
$Team=Api 0 '/api/v1/remote/workspaces' 'POST' @{name=$Tag}
$EnvA="$Tag-PC-A";$EnvB="$Tag-PC-B";$EnvServer="$Tag-server"
$TargetA=PrepareTarget 0 '/api/v1' $PersonalA.id $EnvA 'PC-A' 'http://localhost:18182'
$TargetB=PrepareTarget 1 '/api/v1' $PersonalB.id $EnvB 'PC-B' 'http://localhost:18186'
$TargetServer=PrepareTarget 0 '/api/v1/remote' $Team.id $EnvServer 'SERVER' 'http://server:18080'
function Node($Id,$Agent){return @{id=$Id;name=$Id;type='http';executionAgent=$Agent;method='GET';reqMode='server';respType='json';baseUrl='{{PAYMENT_BASE_URL@env}}';path='/probe';fields=@{headers=@(@{key='x-api-key';value='{{API_KEY@secret}}'})};outputs=@(@{key='origin'});agentOutputs=@('origin');x=200;y=0}}
$Graph=@{nodes=@(@{id='start';type='start';x=0;y=0},(Node 'pc-request' 'local'),(Node 'server-request' 'server'),@{id='end';type='end';x=800;y=0});edges=@(@{id='e1';from='start';to='pc-request'},@{id='e2';from='pc-request';to='server-request'},@{id='e3';from='server-request';to='end'})}
$Flow=Api 0 '/api/v1/remote/flows' 'POST' @{name=$Tag;workspaceId=$Team.id}
$null=Api 0 "/api/v1/remote/flows/$($Flow.id)/versions" 'POST' @{graph=$Graph}
$Before=Api 0 "/api/v1/remote/flows/$($Flow.id)"
$Runs=@()
for($I=0;$I -lt 2;$I++){
  $Env=if($I -eq 0){$EnvA}else{$EnvB}
  $Target=if($I -eq 0){$TargetA}else{$TargetB}
  $Connection=Api $I '/api/v1/desktop/connection'
  $Expected=@{'X-FlowLink-Server'=$Connection.serverUrl;'X-FlowLink-Account'=$Connection.login}
  $Path="/api/v1/desktop/environment-bindings?origin=server&workspaceId=$($Team.id)&environment=$EnvServer"
  $Mapping=Api $I $Path 'GET' $null $Expected
  Check (@($Mapping.bindings.PSObject.Properties).Count -eq 0) "PC $I does not inherit the other PC's private environment binding"
  $Map=@{local=$Env};$Map["server:$($Team.id)"]=$EnvServer
  $Saved=Api $I '/api/v1/desktop/environment-bindings' 'PUT' @{origin='server';workspaceId=$Team.id;environment=$EnvServer;bindings=$Map;revision=$Mapping.revision} $Expected
  $Loaded=Api $I $Path 'GET' $null $Expected
  Check ($Loaded.bindings.local -eq $Env -and $Loaded.revision -eq $Saved.revision) "PC $I saves its own environment binding in H2"
  $Inspection=Api $I '/api/v1/agent/inspect' 'POST' @{node=$Graph.nodes[1];workspaceId=$(if($I -eq 0){$PersonalA.id}else{$PersonalB.id});envName=$Env}
  Check ($Inspection.ready -and $Inspection.targetDiagnostics.resolvedTarget.StartsWith($Target.url)) "PC $I resolves the request target at its own runtime"
  $Request=@{envName=$EnvServer;agentEnvironments=$Map}
  $Started=Api $I "/api/v1/remote/flows/$($Flow.id)/runs" 'POST' $Request
  $Result=WaitRun $I $Started.id;$Runs+=$Result.id
  Check ($Result.status -eq 'SUCCEEDED') "PC $I executes the same shared workflow successfully"
  $Pc=@($Result.nodes|Where-Object nodeId -eq 'pc-request')[-1]
  $Server=@($Result.nodes|Where-Object nodeId -eq 'server-request')[-1]
  Check ($Pc.output.origin -eq $(if($I -eq 0){'PC-A'}else{'PC-B'}) -and $Server.output.origin -eq 'SERVER') "PC $I and Docker each use their intended target and secret"
  $Wire=$Result|ConvertTo-Json -Depth 60 -Compress
  Check (-not $Wire.Contains($Target.secret) -and -not $Wire.Contains($TargetServer.secret)) "PC $I history does not reveal credential values"
}
$ServerInspect=Api 0 '/api/v1/remote/agent/inspect' 'POST' @{node=$Graph.nodes[2];workspaceId=$Team.id;envName=$EnvServer}
Check ($ServerInspect.ready -and $ServerInspect.targetDiagnostics.resolvedTarget.StartsWith('http://server:18080')) 'Server resolves a Docker DNS target, not the PC loopback endpoint'
$Missing=Api 0 '/api/v1/agent/inspect' 'POST' @{node=$Graph.nodes[1];workspaceId=$PersonalA.id;envName=''}
Check (-not $Missing.ready) 'Missing target and credential references are rejected before execution'
$Started=Api 0 "/api/v1/remote/flows/$($Flow.id)/runs" 'POST' @{envName=$EnvServer}
$Rejected=WaitRun 0 $Started.id
Check ($Rejected.status -eq 'FAILED') 'Missing PC environment mapping cannot silently run with common credentials'
$After=Api 0 "/api/v1/remote/flows/$($Flow.id)"
Check (($Before|ConvertTo-Json -Depth 60 -Compress) -eq ($After|ConvertTo-Json -Depth 60 -Compress)) 'Both PCs executed without changing the shared graph'
$Evidence=@{tag=$Tag;workspaceId=$Team.id;flowId=$Flow.id;environmentA=$EnvA;environmentB=$EnvB;environmentServer=$EnvServer;runs=$Runs;checks=$Checks}
$Out=Join-Path (Split-Path -Parent $AgentFile) 'environment-routing-result.json'
$Evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $Out -Encoding utf8
Write-Output "Completed $Checks checks; evidence stored beside the isolated agent file."
