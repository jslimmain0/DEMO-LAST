# Run against an isolated personal app configured with an unreachable loopback server.
# No central server changes, MCP calls, or IDE configuration writes.
param([Parameter(Mandatory=$true)][string]$AgentFile)
$ErrorActionPreference = 'Stop'
$Agent = Get-Content -LiteralPath $AgentFile -Raw | ConvertFrom-Json
if (([uri]$Agent.baseUrl).Host -ne '127.0.0.1') { throw 'Use an isolated loopback personal app.' }
$Headers = @{ 'X-FlowLink-Local' = $Agent.token }
function Api($Path, $Method = 'GET', $Body = $null) {
  $Args = @{ Uri=($Agent.baseUrl+$Path); Method=$Method; Headers=$Headers; TimeoutSec=30 }
  if ($null -ne $Body) { $Args.ContentType='application/json; charset=utf-8'; $Args.Body=[Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 30 -Compress)) }
  $Response = Invoke-RestMethod @Args
  $Response
}
function Check($Condition, $Name) { if (-not $Condition) { throw "FAIL: $Name" }; Write-Output "PASS: $Name" }
$Connection = Api '/api/v1/desktop/connection'
if (([uri]$Connection.serverUrl).Host -ne '127.0.0.1') { throw 'The test server must be isolated loopback.' }
$Probe = [Net.Sockets.TcpClient]::new()
try {
  $Probe.Connect(([uri]$Connection.serverUrl).Host, ([uri]$Connection.serverUrl).Port)
  throw 'The configured server is reachable; this is not an offline test.'
} catch [Net.Sockets.SocketException] { } finally { $Probe.Dispose() }
Check (-not $Connection.connected) 'Personal app started with an unreachable server and no login'
Check ((Api '/api/v1/auth/config').runtime.kind -eq 'local') 'Authentication bootstrap comes from the personal app'
Check ((Api '/api/v1/auth/me').roles -contains 'editor') 'Personal editing does not require central authentication'
$Personal = @(Api '/api/v1/workspaces') | Where-Object kind -eq 'PERSONAL' | Select-Object -First 1
Check ($null -ne $Personal) 'Personal H2 workspace is available offline'
try { $null=Api '/api/v1/desktop/login/start' 'POST' @{}; throw 'Expected connection failure' }
catch { if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 503) { throw } }
$Flow = Api '/api/v1/flows' 'POST' @{ name=('서버 없이 개인 실행 '+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); workspaceId=$Personal.id }
$Graph = @{
  nodes=@(@{id='s';type='start'}, @{id='v';type='set';executionAgent='local';vars=@(@{key='marker';value='offline'})}, @{id='a';type='assert';executionAgent='local';condition="{{ marker@v }} == 'offline'"}, @{id='e';type='end'})
  edges=@(@{id='sv';from='s';to='v'}, @{id='va';from='v';to='a'}, @{id='ae';from='a';to='e'})
}
$null=Api "/api/v1/flows/$($Flow.id)/versions" 'POST' @{graph=$Graph}
Check ((Api "/api/v1/flows/$($Flow.id)").name -eq $Flow.name) 'Personal create, save and read continue after failed login'
$Run=Api "/api/v1/flows/$($Flow.id)/runs" 'POST' @{}
$Deadline=[DateTime]::UtcNow.AddSeconds(20)
do {
  $Run=Api "/api/v1/executions/$($Run.id)"
  if ($Run.status -in @('SUCCEEDED','FAILED','CANCELLED')) { break }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $Deadline)
Check ($Run.status -eq 'SUCCEEDED') 'PC SET and ASSERT finish with the configured server offline'
Check (@(Api '/api/v1/workspaces' | Where-Object kind -eq 'PERSONAL').Count -eq 1) 'Failed central login does not remove the personal workspace'
@{ personalWorkspace=$Personal.id; flowId=$Flow.id; executionId=$Run.id; status=$Run.status; serverReachable=$false } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $AgentFile) 'offline-fixtures.json') -Encoding UTF8
