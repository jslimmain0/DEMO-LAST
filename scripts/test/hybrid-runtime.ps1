# Native Dispatcher + REST integration. Does not invoke MCP or an IDE.
# Uses isolated lab runtimes; leaves uniquely named fixtures for UI inspection.
param(
  [Parameter(Mandatory=$true)][string]$AgentFile,
  [string]$ServerUrl = 'http://127.0.0.1:18080',
  [int]$TimeoutSec = 90
)
$ErrorActionPreference = 'Stop'
$Agent = Get-Content -LiteralPath $AgentFile -Raw | ConvertFrom-Json
if (([uri]$Agent.baseUrl).Host -ne '127.0.0.1' -or ([uri]$ServerUrl).Host -ne '127.0.0.1') { throw 'Use isolated loopback test runtimes.' }
$Headers = @{ 'X-FlowLink-Local' = $Agent.token }
$Tag = 'hybrid-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Checks = 0
function Check($Condition, $Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:Checks++; Write-Output "PASS $script:Checks $Name" }
function Api($Path, $Method = 'GET', $Body = $null) {
  $Arguments = @{ Uri = ($Agent.baseUrl + $Path); Method = $Method; Headers = $Headers; UseBasicParsing = $true }
  if ($null -ne $Body) { $Arguments.ContentType = 'application/json; charset=utf-8'; $Arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 50 -Compress)) }
  $Response = Invoke-WebRequest @Arguments
  if ($Response.Content) { return $Response.Content | ConvertFrom-Json }
}
function Rejected($Path, $Method = 'GET', $Body = $null, $Status = 403) {
  try { $null = Api $Path $Method $Body; throw "Expected HTTP $Status" }
  catch { if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne $Status) { throw } }
}
function Wait-Run($Prefix, $Id) {
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
  do {
    $Detail = Api "$Prefix/executions/$Id"
    if ($Detail.status -in @('SUCCEEDED','FAILED','CANCELLED')) { return $Detail }
    if ($Detail.pendingAgent.status -eq 'UNKNOWN') { throw "Execution $Id has an uncertain task; it was not retried." }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "Execution $Id did not complete. status=$($Detail.status) task=$($Detail.pendingAgent.status)"
}
function New-Flow($Prefix, $Name, $Workspace, $Middle) {
  $Nodes = @(@{ id='start'; type='start'; name='start'; x=0; y=100 }) + @($Middle) + @(@{ id='end'; type='end'; name='end'; x=1100; y=100 })
  $Edges = @()
  for ($Index=1; $Index -lt $Nodes.Count; $Index++) { $Edges += @{ id="edge-$Index"; from=$Nodes[$Index-1].id; to=$Nodes[$Index].id; fromPort='out' } }
  $Created = Api "$Prefix/flows" 'POST' @{ name="$Tag $Name"; workspaceId=$Workspace }
  $null = Api "$Prefix/flows/$($Created.id)/versions" 'POST' @{ graph=@{ nodes=$Nodes; edges=$Edges } }
  return $Created
}
function New-Mock($Prefix, $Workspace) {
  $Created = Api "$Prefix/mock-servers" 'POST' @{ name=$Tag; slug=$Tag; type='HTTP'; workspaceId=$Workspace }
  $SecretRef = '{{ ' + $Tag + '@secret }}'
  $Hidden = if ($Prefix -eq '/api/v1') { 'PC-UNSELECTED-PRIVATE-FIELD' } else { 'SERVER-UNSELECTED-PRIVATE-FIELD' }
  $Body = '{"origin":"{{ marker@env }}","amount":42,"ok":true,"labels":["한글","agent"],"hidden":"' + $Hidden + '","private":"' + $SecretRef + '"}'
  $null = Api "$Prefix/mock-servers/$($Created.id)/spec" 'PUT' @{ spec=@{ environment=$Tag; routes=@(@{
    id='probe'; method='GET'; path='/probe'; rules=@(
      @{ id='authenticated'; when=@(@{ source='header'; key='x-agent-key'; op='eq'; value=$SecretRef }); status=200; contentType='json'; body=$Body },
      @{ id='wrong-agent-secret'; status=401; contentType='json'; body='{"error":"wrong execution environment"}' }
    )
  }) } }
  return Api "$Prefix/mock-servers/$($Created.id)"
}
function Http-Node($Id, $Location, $Workspace = $null) {
  $Node = @{ id=$Id; name=$Id; type='http'; x=250; y=100; method='GET'; reqMode='server'; respType='json';
    executionAgent=$Location; agentEnvironment=$Tag; agentMock=$Tag; baseUrl='http://127.0.0.1:1'; path='/probe';
    agentOutputs=@('origin','amount','ok','labels'); outputs=@(@{key='origin'},@{key='amount'},@{key='ok'},@{key='labels'});
    fields=@{ headers=@(@{key='x-agent-key'; value=('{{ '+$Tag+'@secret }}')}); params=@(); body=@() } }
  if ($Workspace) { $Node.agentWorkspaceId = $Workspace }
  return $Node
}

$Personal = @(Api '/api/v1/workspaces') | Where-Object kind -eq 'PERSONAL' | Select-Object -First 1
Check ($null -ne $Personal) 'Personal H2 workspace is present before login'
$null = Api '/api/v1/desktop/connection' 'PUT' @{ serverUrl=$ServerUrl }
$Login = Api '/api/v1/desktop/connection'
if (-not $Login.connected) {
  $Start = Api '/api/v1/desktop/login/start' 'POST' @{}
  Check ($Start.userCode -eq 'MOCK-LOGIN') 'Uses the lab mock login instead of external GitHub'
  $null = Api '/api/v1/desktop/login/poll'
}
$Team = Api '/api/v1/remote/workspaces' 'POST' @{ name=$Tag }
$Other = Api '/api/v1/remote/workspaces' 'POST' @{ name="$Tag isolated" }
$Local = '/api/v1'; $Remote = '/api/v1/remote'
$LocalSecret = 'PC-private-' + [guid]::NewGuid().ToString('N')
$ServerSecret = 'SERVER-private-' + [guid]::NewGuid().ToString('N')
$null = Api "$Local/environments/$Tag`?workspaceId=$($Personal.id)" 'PUT' @{ vars=@{ marker='PC' } }
$null = Api "$Remote/environments/$Tag`?workspaceId=$($Team.id)" 'PUT' @{ vars=@{ marker='SERVER' } }
$null = Api "$Remote/environments/$Tag`?workspaceId=$($Other.id)" 'PUT' @{ vars=@{ marker='OTHER-TEAM' } }
$null = Api "$Local/secrets/$Tag`?workspaceId=$($Personal.id)" 'PUT' @{ environment=$Tag; value=$LocalSecret }
$null = Api "$Remote/secrets/$Tag`?workspaceId=$($Team.id)" 'PUT' @{ environment=$Tag; value=$ServerSecret }
$LocalMock = New-Mock $Local $Personal.id
$ServerMock = New-Mock $Remote $Team.id
$OtherMock = New-Mock $Remote $Other.id
Check ($LocalMock.listener.agent -eq 'local' -and $LocalMock.listener.state -eq 'LISTENING') 'Personal Mock is listening on the PC'
Check ($ServerMock.listener.agent -eq 'server' -and $ServerMock.listener.state -eq 'LISTENING') 'Team Mock is listening on the server'
Check ($ServerMock.basePath -ne $OtherMock.basePath -and $ServerMock.slug -eq $OtherMock.slug) 'Same Mock slug is isolated by remote workspace'
Check ((@(Api "$Local/environments?workspaceId=$($Personal.id)") | Where-Object name -eq $Tag).vars.marker -eq 'PC') 'PC environment stays in H2'
Check ((@(Api "$Remote/environments?workspaceId=$($Team.id)") | Where-Object name -eq $Tag).vars.marker -eq 'SERVER') 'Server environment uses the team scope'
Check ((@(Api "$Remote/environments?workspaceId=$($Other.id)") | Where-Object name -eq $Tag).vars.marker -eq 'OTHER-TEAM') 'Other team cannot replace the selected team environment'

$PcNode = Http-Node 'pc-order' 'local'
$ServerNode = Http-Node 'server-payment' 'server' $Team.id
$ServerNode.fields.params = @(@{key='amount'; value='{{ amount@pc-order }}'})
$Verify = @{ id='pc-check'; name='PC에서 검증'; type='assert'; x=750; y=100; executionAgent='local';
  agentEnvironment=$Tag;
  condition="{{ origin@pc-order }} == 'PC' && {{ origin@server-payment }} == 'SERVER' && {{ amount@pc-order }} == 42 && {{ ok@server-payment }} == true" }
$TeamFlow = New-Flow $Remote 'PC-server-PC' $Team.id @($PcNode,$ServerNode,$Verify)
$Started = Api "$Remote/flows/$($TeamFlow.id)/runs" 'POST' @{}
$Result = Wait-Run $Remote $Started.id
Check ($Result.status -eq 'SUCCEEDED' -and $Result.id -eq $Started.id) 'Native Dispatcher completes PC-server-PC under one team execution ID without a browser'
$PcResult = @($Result.nodes | Where-Object nodeId -eq 'pc-order')[-1]
$ServerResult = @($Result.nodes | Where-Object nodeId -eq 'server-payment')[-1]
Check ($PcResult.executionAgent -eq 'local' -and $ServerResult.executionAgent -eq 'server') 'Execution history records the actual agent per node'
Check ($PcResult.output.origin -eq 'PC' -and $ServerResult.output.origin -eq 'SERVER') 'Same logical Mock resolves to different physical listeners'
Check (($PcResult.output.amount -is [int] -or $PcResult.output.amount -is [long]) -and $PcResult.output.ok -is [bool] -and $PcResult.output.labels[0] -eq '한글') 'Numbers, booleans, arrays and Korean survive the agent boundary'
Check (-not ($PcResult.output.PSObject.Properties.Name -contains 'hidden') -and -not ($PcResult.output.PSObject.Properties.Name -contains 'private')) 'Only explicitly allowed PC outputs enter team history'
$Wire = $Result | ConvertTo-Json -Depth 50 -Compress
Check (-not $Wire.Contains($LocalSecret) -and -not $Wire.Contains($ServerSecret) -and -not $Wire.Contains('PC-UNSELECTED-PRIVATE-FIELD')) 'Known secrets and unselected PC response fields do not leak through raw capture'
Rejected "$Local/flows/$($TeamFlow.id)" 'GET' $null 404
Check $true 'Team definition was not copied into personal H2'
$LocalLog = @(Api "$Local/mock-servers/$($LocalMock.id)/requests")
$ServerLog = @(Api "$Remote/mock-servers/$($ServerMock.id)/requests")
Check ($LocalLog.Count -eq 1 -and $ServerLog.Count -eq 1) 'Each physical Mock received exactly one request'

$SuiteFolder = Api "$Remote/folders" 'POST' @{ name="$Tag suite"; workspaceId=$Team.id }
$null = Api "$Remote/flows/$($TeamFlow.id)/folder" 'PUT' @{ folderId=$SuiteFolder.id }
$Suite = @(Api "$Remote/suites/run" 'POST' @{ folderId=$SuiteFolder.id })
Check ($Suite.Count -eq 1 -and $Suite[0].executionId) 'Folder suite fixes individual execution IDs before starting'
Check ((Wait-Run $Remote $Suite[0].executionId).status -eq 'SUCCEEDED') 'Suite execution uses the same native hybrid Dispatcher'

$PrivateServer = Http-Node 'server-private' 'server' $Team.id
$PrivateVerify = @{ id='local-check'; type='assert'; executionAgent='local'; condition="{{ origin@server-private }} == 'SERVER' && {{ amount@server-private }} == 42" }
$PrivateFlow = New-Flow $Local 'personal-server-delegation' $Personal.id @($PrivateServer,$PrivateVerify)
$PrivateRun = Api "$Local/flows/$($PrivateFlow.id)/runs" 'POST' @{}
$PrivateResult = Wait-Run $Local $PrivateRun.id
Check ($PrivateResult.status -eq 'SUCCEEDED') 'Personal flow delegates one node to the server and resumes locally'
Rejected "$Remote/flows/$($PrivateFlow.id)" 'GET' $null 404
Rejected "$Remote/executions/$($PrivateRun.id)" 'GET' $null 404
Check $true 'Private flow and original execution history are not uploaded to the server'
Check (@(Api '/api/v1/workspaces' | Where-Object kind -eq 'PERSONAL').Count -eq 1) 'Personal workspace remains available after login'

$OfflineFlow = New-Flow $Local 'personal-after-logout' $Personal.id @(
  @{ id='local-value'; type='set'; executionAgent='local'; vars=@(@{key='marker';value='offline'}) },
  @{ id='local-assert'; type='assert'; executionAgent='local'; condition="{{ marker@local-value }} == 'offline'" }
)
$null = Api '/api/v1/desktop/logout' 'POST' @{}
try {
  Check (-not (Api '/api/v1/desktop/connection').connected) 'Server logout clears the app login'
  Check (@(Api '/api/v1/workspaces' | Where-Object kind -eq 'PERSONAL').Count -eq 1) 'Personal workspace remains available after logout'
  $OfflineRun = Api "$Local/flows/$($OfflineFlow.id)/runs" 'POST' @{}
  Check ((Wait-Run $Local $OfflineRun.id).status -eq 'SUCCEEDED') 'PC-only execution continues without a server login'
} finally {
  $Restore = Api '/api/v1/desktop/login/start' 'POST' @{}
  if ($Restore.userCode -ne 'MOCK-LOGIN') { throw 'Lab mock login is required to restore the session.' }
  $null = Api '/api/v1/desktop/login/poll'
}

$File = Join-Path (Split-Path -Parent $AgentFile) 'hybrid-fixtures.json'
@{ checks=$Checks; tag=$Tag; personalWorkspace=$Personal.id; teamWorkspace=$Team.id; otherWorkspace=$Other.id;
  localMock=$LocalMock.id; serverMock=$ServerMock.id; teamFlow=$TeamFlow.id; teamExecution=$Result.id;
  personalFlow=$PrivateFlow.id; personalExecution=$PrivateResult.id; offlineFlow=$OfflineFlow.id } | ConvertTo-Json | Set-Content -LiteralPath $File -Encoding UTF8
Write-Output "ALL $Checks PASS; fixtures saved in $File"
