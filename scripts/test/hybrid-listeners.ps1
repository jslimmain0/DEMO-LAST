# REST/TCP only. Uses the isolated hybrid-runtime.ps1 fixtures; never invokes MCP.
param([Parameter(Mandatory=$true)][string]$AgentFile)
$ErrorActionPreference = 'Stop'
$Agent = Get-Content -LiteralPath $AgentFile -Raw | ConvertFrom-Json
$Fixtures = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $AgentFile) 'hybrid-fixtures.json') -Raw | ConvertFrom-Json
$Tag = 'listeners-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Checks = 0
function Check($Condition, $Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:Checks++; Write-Output "PASS $script:Checks $Name" }
function Api($Path, $Method='GET', $Body=$null) {
  $Args = @{ Uri=$Agent.baseUrl+$Path; Method=$Method; Headers=@{'X-FlowLink-Local'=$Agent.token}; UseBasicParsing=$true }
  if ($null -ne $Body) { $Args.ContentType='application/json'; $Args.Body=[Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 40 -Compress)) }
  $Response = Invoke-WebRequest @Args
  if ($Response.Content) { $Response.Content | ConvertFrom-Json }
}
function Wait-Run($Prefix,$Id) {
  for ($Attempt=0; $Attempt -lt 180; $Attempt++) {
    $Run = Api "$Prefix/executions/$Id"
    if ($Run.status -in @('SUCCEEDED','FAILED','CANCELLED')) { return $Run }
    if ($Run.pendingAgent.status -eq 'UNKNOWN') { throw 'Uncertain task was not repeated.' }
    Start-Sleep -Milliseconds 200
  }
  throw "Run $Id did not finish"
}
function Flow($Prefix,$Space,$Name,$Middle) {
  $Nodes=@(@{id='start';type='start'})+@($Middle)+@(@{id='end';type='end'})
  $Edges=@(); for($I=1;$I -lt $Nodes.Count;$I++) { $Edges+=@{id="e$I";from=$Nodes[$I-1].id;to=$Nodes[$I].id;fromPort='out'} }
  $F=Api "$Prefix/flows" 'POST' @{name="$Tag $Name";workspaceId=$Space}
  $null=Api "$Prefix/flows/$($F.id)/versions" 'POST' @{graph=@{nodes=$Nodes;edges=$Edges}}
  return $F
}

foreach($Runtime in @('local','server')) {
  $Prefix=if($Runtime -eq 'local') {'/api/v1'} else {'/api/v1/remote'}
  $Space=if($Runtime -eq 'local') {$Fixtures.personalWorkspace} else {$Fixtures.teamWorkspace}
  $Flow=Flow $Prefix $Space "early-callback-$Runtime" @(
    @{id='gate';type='input';waitMsg='콜백 선도착 검증';waitFields=@(@{key='go';type='string'})},
    @{id='callback';type='wait';waitTimeoutSec=30;callbackRespType='json';callbackRespBody='{"accepted":true}'},
    @{id='check';type='assert';executionAgent=$Runtime;condition="{{ accepted@callback }} == 'first'"}
  )
  $Run=Api "$Prefix/flows/$($Flow.id)/runs" 'POST' @{}
  Check ($Run.pendingInput.nodeId -eq 'gate') "$Runtime waits for user input before WAIT"
  $Base=if($Runtime -eq 'local') {$Agent.baseUrl} else {(Api '/api/v1/desktop/connection').serverUrl}
  $Callback="$Base/relay/$($Run.id)/cb/callback"
  $Ack=Invoke-RestMethod -Uri $Callback -Method POST -ContentType 'application/json' -Body '{"accepted":"first"}'
  Check ($Ack.accepted -eq $true) "$Runtime listener acknowledges an early callback with configured response"
  $null=Invoke-RestMethod -Uri $Callback -Method POST -ContentType 'application/json' -Body '{"accepted":"duplicate"}'
  $null=Api "$Prefix/executions/$($Run.id)/resume" 'POST' @{nodeId='gate';formValues=@{go='yes'}}
  $Done=Wait-Run $Prefix $Run.id
  Check ($Done.status -eq 'SUCCEEDED') "$Runtime consumes first callback once after reaching WAIT"
  Check (@($Done.nodes | Where-Object nodeId -eq 'callback').Count -eq 1) "$Runtime duplicate callback creates no duplicate node result"
  $Wait=@($Done.nodes | Where-Object nodeId -eq 'callback')[0]
  $ListenerUri=[uri]$Wait.output.url; $OwnerUri=[uri]$Base
  Check ($ListenerUri.Port -eq $OwnerUri.Port -and $ListenerUri.Host -in @('localhost','127.0.0.1') -and $ListenerUri.AbsolutePath.StartsWith('/relay/')) "$Runtime callback URL belongs to workflow owner"
}

$Probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $Probe.Start(); $PcPort=$Probe.LocalEndpoint.Port; $Probe.Stop()
$Spec=@{ encoding='UTF-8';lengthField='len';includesSelf=$true;
  header=@(@{name='len';len=4;type='length'});
  messages=@(@{key='request';fields=@(@{name='message';len=8;type='string'})},@{key='response';fields=@(@{name='origin';len=8;type='string'})}) }
$TcpNodes=@()
foreach($Runtime in @('local','server')) {
  $Prefix=if($Runtime -eq 'local') {'/api/v1'} else {'/api/v1/remote'}
  $Space=if($Runtime -eq 'local') {$Fixtures.personalWorkspace} else {$Fixtures.teamWorkspace}
  $Used=@((Api '/api/v1/remote/mock-servers/fleet').servers | Where-Object listening | ForEach-Object tcpPort)
  $Port=if($Runtime -eq 'local') {$PcPort} else {@(9091..9190 | Where-Object { $_ -notin $Used })[0]}
  $Protocol=Api "$Prefix/protocols" 'POST' @{name=$Tag;workspaceId=$Space;spec=$Spec}
  $Mock=Api "$Prefix/mock-servers" 'POST' @{name=$Tag;slug=$Tag;workspaceId=$Space;type='TCP'}
  $null=Api "$Prefix/mock-servers/$($Mock.id)/spec" 'PUT' @{spec=@{tcp=@{port=$Port;protocolId=$Protocol.id;rules=@(@{id='reply';then=@{mode='mock';fields=@{origin=$Runtime}}})}}}
  $Mock=Api "$Prefix/mock-servers/$($Mock.id)"
  Check ($Mock.listener.state -eq 'LISTENING' -and $Mock.listener.agent -eq $Runtime) "$Runtime TCP listener is ready on its own agent"
  $Node=@{id=$Runtime;type='tcp';executionAgent=$Runtime;agentMock=$Tag;protocolId=$Protocol.id;tcpMessage='request';tcpResponseMessage='response';tcpValues=@{message='PING'};agentOutputs=@('origin')}
  if($Runtime -eq 'server') {$Node.agentWorkspaceId=$Space}
  $TcpNodes+=$Node
}
$TcpNodes+=@{id='verify';type='assert';executionAgent='local';condition="{{ origin@local }} == 'local' && {{ origin@server }} == 'server'"}
$Flow=Flow '/api/v1/remote' $Fixtures.teamWorkspace 'TCP-PC-server-PC' $TcpNodes
$Run=Api "/api/v1/remote/flows/$($Flow.id)/runs" 'POST' @{}
$Done=Wait-Run '/api/v1/remote' $Run.id
Check ($Done.status -eq 'SUCCEEDED') 'TCP mixed workflow uses separately scoped schemas and physical listeners'
$Single=Api "/api/v1/remote/flows/$($Flow.id)/runs" 'POST' @{onlyNodeId='local'}
$SingleDone=Wait-Run '/api/v1/remote' $Single.id
Check ($SingleDone.status -eq 'SUCCEEDED' -and @($SingleDone.nodes).Count -eq 1 -and $SingleDone.nodes[0].executionAgent -eq 'local') 'Single-node run uses the native Dispatcher and same durable history'
Write-Output "ALL $Checks LISTENER CHECKS PASS"
