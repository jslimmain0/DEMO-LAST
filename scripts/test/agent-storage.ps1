# REST/storage regression only. No MCP calls.
param([Parameter(Mandatory=$true)][string]$AgentFile, [string]$ServerUrl = 'http://127.0.0.1:18080')
$ErrorActionPreference = 'Stop'
$Agent = Get-Content -LiteralPath $AgentFile -Raw | ConvertFrom-Json
if (([uri]$Agent.baseUrl).Host -ne '127.0.0.1' -or ([uri]$ServerUrl).Host -ne '127.0.0.1') { throw 'Use isolated loopback test runtimes.' }
$Headers = @{ 'X-FlowLink-Local' = $Agent.token }
$Checks = 0
function Check($Condition, $Name) { if (-not $Condition) { throw "FAIL: $Name" }; $script:Checks++; Write-Output "PASS $script:Checks $Name" }
function Api($Path, $Method = 'GET', $Body = $null) {
  $Args = @{ Uri = ($Agent.baseUrl + $Path); Method = $Method; Headers = $Headers; UseBasicParsing = $true }
  if ($null -ne $Body) { $Args.ContentType = 'application/json'; $Args.Body = ($Body | ConvertTo-Json -Depth 30 -Compress) }
  $Response = Invoke-WebRequest @Args
  if ($Response.Content) { return $Response.Content | ConvertFrom-Json }
}
function Rejected($Path, $Method = 'GET', $Body = $null, $Status = 403) {
  try { $null = Api $Path $Method $Body; throw "Expected HTTP $Status" }
  catch { if ([int]$_.Exception.Response.StatusCode -ne $Status) { throw } }
}
$Local = @(Api '/api/v1/workspaces')
Check ($Local.Count -eq 1 -and $Local[0].kind -eq 'PERSONAL') 'PC exposes one personal workspace'
Rejected '/api/v1/workspaces' 'POST' @{ name = 'must-not-create-team-on-pc' }
Rejected '/api/v1/flows?workspaceId=public'
Check $true 'PC rejects teams and public scope'
$Connection = Api '/api/v1/desktop/connection' 'PUT' @{ serverUrl = $ServerUrl }
Check ($Connection.serverUrl -eq $ServerUrl -and $Connection.mcpUrl) 'Server and MCP metadata are discovered automatically'
$Start = Api '/api/v1/desktop/login/start' 'POST' @{}
Check ($Start.userCode -eq 'MOCK-LOGIN') 'Mock identity uses the normal login flow'
$Login = Api '/api/v1/desktop/login/poll'
Check ($Login.status -eq 'ready' -and -not ($Login.PSObject.Properties.Name -contains 'token')) 'App stores session without returning JWT to browser'
$Remote = @(Api '/api/v1/remote/workspaces')
Check (@($Remote | Where-Object kind -eq 'PERSONAL').Count -eq 0) 'Server exposes no personal workspace'
Rejected '/api/v1/remote/flows?workspaceId=local'
Check $true 'Server rejects personal alias'
$Tag = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$Team = Api '/api/v1/remote/workspaces' 'POST' @{ name = "agent-storage-$Tag" }
$PrivateFlow = Api '/api/v1/flows' 'POST' @{ name = "private-$Tag" }
$TeamFlow = Api '/api/v1/remote/flows' 'POST' @{ name = "team-$Tag"; workspaceId = $Team.id }
Rejected "/api/v1/flows/$($TeamFlow.id)" 'GET' $null 404
Rejected "/api/v1/remote/flows/$($PrivateFlow.id)" 'GET' $null 404
Check $true 'PC and server cannot read each others flow IDs'
$LocalIds = @(Api '/api/v1/flows') | ForEach-Object id
Check (-not ($LocalIds -contains $TeamFlow.id)) 'Team data is never copied to PC'
$Graph = @{ nodes = @(@{ id='s'; type='start' }, @{ id='e'; type='end' }); edges = @(@{ id='edge'; from='s'; to='e' }) }
$null = Api "/api/v1/remote/flows/$($TeamFlow.id)/versions" 'POST' @{ graph = $Graph }
$Run = Api "/api/v1/remote/flows/$($TeamFlow.id)/runs" 'POST' @{}
for ($Attempt = 0; $Attempt -lt 60; $Attempt++) { $Run = Api "/api/v1/remote/executions/$($Run.id)"; if ($Run.status -ne 'RUNNING') { break }; Start-Sleep -Milliseconds 100 }
Check ($Run.status -eq 'SUCCEEDED') 'Team execution completes on server'
Rejected "/api/v1/remote/workspaces/$($Team.id)" 'DELETE' $null 400
Check $true 'Nonempty team requires explicit remote destination'
$Destination = Api '/api/v1/remote/workspaces' 'POST' @{ name = "agent-destination-$Tag" }
$null = Api "/api/v1/remote/workspaces/$($Team.id)?moveTo=$($Destination.id)" 'DELETE'
$Moved = Api "/api/v1/remote/flows/$($TeamFlow.id)"
Check ($Moved.workspaceId -eq $Destination.id) 'Explicit team transfer preserves flow ID and execution history'
Check ((Api "/api/v1/remote/executions/$($Run.id)").status -eq 'SUCCEEDED') 'Execution history remains accessible after transfer'
$File = Join-Path (Split-Path -Parent $AgentFile) 'storage-fixtures.json'
@{ localWorkspace=$Local[0].id; privateFlow=$PrivateFlow.id; teamWorkspace=$Destination.id; teamFlow=$TeamFlow.id; executionId=$Run.id; checks=$Checks } | ConvertTo-Json | Set-Content -LiteralPath $File -Encoding UTF8
Write-Output "ALL $Checks PASS"
