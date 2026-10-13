#Requires -Version 7
# Explicitly authorized MCP wire smoke. Uses fresh loopback hosts, H2, PC keys and MCP registries only.
param([string]$JavaHome = $env:JAVA_HOME, [int]$TimeoutSeconds = 120)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$serverJar = Join-Path $repo 'backend/flow-server/build/libs/flowlink-server.jar'
$desktopJar = Join-Path $repo 'backend/flow-desktop/build/libs/flowlink-desktop.jar'
foreach ($jar in @($serverJar, $desktopJar)) { if (!(Test-Path -LiteralPath $jar)) { throw '먼저 최신 server/desktop bootJar를 빌드하세요.' } }
if (!$JavaHome) { $JavaHome = Join-Path $env:USERPROFILE '.jdks/corretto-21.0.10' }
$java = Join-Path $JavaHome 'bin/java.exe'
if (!(Test-Path -LiteralPath $java)) { throw 'Java 21 JAVA_HOME을 지정하세요.' }
$lab = Join-Path $repo ('.run/mcp-resources-' + [Guid]::NewGuid().ToString('N'))
$pcDir = Join-Path $lab 'pc'
New-Item -ItemType Directory -Path $pcDir -Force | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
$runs = [Collections.Generic.List[object]]::new()
$checks = [Collections.Generic.List[string]]::new()
$sensitive = [Collections.Generic.List[string]]::new()
$appToken = $mcpBearer = $mcpTokenId = $pcToken = $null
$script:rpcId = 0
$script:protocolVersion = '2025-03-26'
$stage = 'launch'
$passed = $false
$failureReason = $null
$cleanupPassed = $true

function Assert([bool]$condition, [string]$message) { if (!$condition) { throw $message } }
function Checked([string]$name) { $checks.Add($name); Write-Host "PASS: $name" }
function Free-Port {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
$serverPort = Free-Port
do { $pcPort = Free-Port } while ($pcPort -eq $serverPort)
$serverUrl = "http://127.0.0.1:$serverPort"
$pcUrl = "http://127.0.0.1:$pcPort"
$registry = Join-Path $lab 'tokens.json'
$signingKey = [Guid]::NewGuid().ToString('N')
$sensitive.Add($signingKey)
function Redact([string]$value) {
    foreach ($secret in $sensitive) { if ($secret) { $value = $value.Replace($secret, '[REDACTED]') } }
    return [regex]::Replace($value, 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED-JWT]')
}
function Launch([string]$role, [string]$jar, [string[]]$arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($java)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.WorkingDirectory = $lab
    foreach ($key in @($info.Environment.Keys)) { if ($key -match '^(FLOWLINK_|SPRING_|SERVER_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$)') { [void]$info.Environment.Remove($key) } }
    foreach ($arg in @("-Duser.home=$lab/$role-home", '-jar', $jar) + $arguments) { $info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info)
    $run = @{ process = $process; out = $process.StandardOutput.ReadToEndAsync(); err = $process.StandardError.ReadToEndAsync(); role = $role }
    $runs.Add($run)
    return $run
}
function Rest([string]$origin, [string]$method, [string]$path, $body = $null) {
    $headers = @{}
    $base = $serverUrl
    if ($origin -eq 'pc') { $base = $pcUrl; if ($pcToken) { $headers['X-FlowLink-Local'] = $pcToken } }
    elseif ($appToken) { $headers['Authorization'] = "Bearer $appToken" }
    $params = @{ Uri = $base + $path; Method = $method; Headers = $headers; SkipHttpErrorCheck = $true; TimeoutSec = 30 }
    if ($null -ne $body) { $params.Body = $body | ConvertTo-Json -Compress -Depth 60; $params.ContentType = 'application/json' }
    try { $response = Invoke-WebRequest @params } catch { throw "REST 전송 실패: $method $path" }
    $data = $null
    if ($response.Content) { try { $data = $response.Content | ConvertFrom-Json -Depth 70 } catch { throw "REST JSON 응답 실패: $method $path" } }
    return @{ code = [int]$response.StatusCode; data = $data }
}
function Ready($run, [string]$origin) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        Assert (!$run.process.HasExited) '격리 앱이 기동 전에 종료됐습니다. 비밀값을 지운 smoke 로그를 확인하세요.'
        if ($origin -eq 'pc') {
            $agentFile = Join-Path $pcDir 'agent.json'
            if (!(Test-Path -LiteralPath $agentFile)) { Start-Sleep -Milliseconds 300; continue }
            $agent = [IO.File]::ReadAllText($agentFile) | ConvertFrom-Json
            $script:pcToken = [string]$agent.token
            $script:deviceId = [string]$agent.deviceId
        }
        try { if ((Rest $origin GET '/api/v1/auth/config').code -eq 200) { return } } catch {}
        Start-Sleep -Milliseconds 300
    }
    throw '격리 앱 준비 시간 초과'
}
function Rpc([string]$method, $arguments = $null) {
    $script:rpcId++
    $id = $script:rpcId
    $body = @{ jsonrpc = '2.0'; id = $id; method = $method }
    if ($null -ne $arguments) { $body.params = $arguments }
    $headers = @{ Authorization = "Bearer $mcpBearer"; Accept = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = $script:protocolVersion }
    try { $response = Invoke-WebRequest "$serverUrl/mcp" -Method Post -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 70 -Compress) -SkipHttpErrorCheck -TimeoutSec 180 }
    catch { throw "MCP HTTP 전송 실패: $method" }
    Assert ([int]$response.StatusCode -eq 200) "MCP HTTP 응답 실패: $method"
    # SDK transports may answer a POST with JSON or SSE. Match this request's response, ignoring notifications.
    $messages = [Collections.Generic.List[object]]::new()
    $content = [string]$response.Content
    if ($response.Headers['Content-Type'] -like '*text/event-stream*' -or $content.TrimStart().StartsWith('event:') -or $content.TrimStart().StartsWith('data:')) {
        foreach ($frame in ($content -split '\r?\n\r?\n')) {
            $data = @($frame -split '\r?\n' | Where-Object { $_.StartsWith('data:') } | ForEach-Object { $_.Substring(5).TrimStart() }) -join "`n"
            if ($data) { try { $messages.Add(($data | ConvertFrom-Json -Depth 70)) } catch { throw "MCP SSE JSON 파싱 실패: $method" } }
        }
    } else {
        try { foreach ($message in @($content | ConvertFrom-Json -Depth 70)) { $messages.Add($message) } } catch { throw "MCP JSON 파싱 실패: $method" }
    }
    $answer = @($messages | Where-Object { [string]$_.id -eq [string]$id })
    Assert ($answer.Count -eq 1 -and !$answer[0].error) "MCP JSON-RPC 응답 실패: $method"
    return $answer[0].result
}
function Tool([string]$name, [hashtable]$arguments = @{}) {
    $script:stage = "tool:$name"
    $result = Rpc 'tools/call' @{ name = $name; arguments = $arguments }
    Assert (!$result.isError) "MCP 도구 실패: $name"
    $text = @($result.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text }) -join "`n"
    # Never print arbitrary tool results. A real secret echo fails this assertion instead of reaching stdout/results.
    foreach ($secret in $sensitive) { Assert (!$secret -or !$text.Contains($secret)) "MCP 응답에 마스킹되지 않은 비밀값이 있습니다: $name" }
    if ($text.TrimStart().StartsWith('{') -or $text.TrimStart().StartsWith('[')) {
        try { return ($text | ConvertFrom-Json -Depth 70) } catch { if ($name -ne 'flowlink_guide') { throw "MCP 도구 JSON 파싱 실패: $name" } }
    }
    return $text
}
function Initialized-Notification {
    $headers = @{ Authorization = "Bearer $mcpBearer"; Accept = 'application/json, text/event-stream'; 'MCP-Protocol-Version' = $script:protocolVersion }
    try { $response = Invoke-WebRequest "$serverUrl/mcp" -Method Post -Headers $headers -ContentType 'application/json' -Body '{"jsonrpc":"2.0","method":"notifications/initialized"}' -SkipHttpErrorCheck -TimeoutSec 10 }
    catch { throw 'MCP initialized 알림 전송 실패' }
    Assert ([int]$response.StatusCode -in @(200, 202, 204)) 'MCP initialized 알림을 거부했습니다.'
}
function No-Metadata($value, [string]$label) {
    Assert (@($value.PSObject.Properties.Name | Where-Object { $_ -in @('resourceWorkspaceId', 'resourceIdentity', 'envSource') }).Count -eq 0) "$label 기존 metadata 없는 계약이 변경됐습니다."
}
function Successful($result, [string]$expectedOrigin) {
    Assert ($result.execution.status -eq 'SUCCEEDED') 'MCP 워크플로 실행이 성공하지 못했습니다.'
    $http = @($result.execution.nodes | Where-Object { $_.nodeId -eq 'request' })
    $transform = @($result.execution.nodes | Where-Object { $_.nodeId -eq 'transform' })
    Assert ($http.Count -eq 1 -and $transform.Count -eq 1) 'HTTP/변환 실행 결과가 없습니다.'
    Assert ($http[0].requestText -match 'origin') 'PC 요청 본문이 디버깅 결과에서 사라졌습니다.'
    Assert ($http[0].output.origin -eq $expectedOrigin -and $transform[0].output.result -eq "$expectedOrigin|$expectedOrigin") '환경 출처·중앙 변환 결과가 일치하지 않습니다.'
    $serialized = $result | ConvertTo-Json -Depth 70 -Compress
    foreach ($secret in @($secretCommon, $secretOverlay)) { Assert (!$serialized.Contains($secret)) '실행의 본문·출력에 시크릿 원문이 노출됩니다.' }
}

try {
    $server = Launch server $serverJar @('--spring.profiles.active=local,agent-lab', "--server.port=$serverPort", '--server.address=127.0.0.1',
        "--spring.datasource.url=jdbc:h2:file:$lab/serverdb;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE", '--spring.datasource.username=sa', '--spring.datasource.password=',
        '--flowlink.auth.github-enabled=true', "--flowlink.auth.jwt-secret=$signingKey", '--flowlink.vault.enabled=false', '--flowlink.vault.transit.enabled=false',
        "--flowlink.plugins.dir=$lab/server-plugins", "--flowlink.mcp.tokens-file=$registry", "--flowlink.mcp.clients-file=$lab/clients.json", '--flowlink.execution.ssrf.allow-loopback=true')
    Ready $server server
    # Official agent-lab REST login only: no synthetic JWT and no real GitHub/OAuth request.
    $started = Rest server POST '/api/v1/auth/github/device/start' @{}
    Assert ($started.code -eq 200) '모의 중앙 로그인 시작 실패'
    $login = Rest server GET ('/api/v1/auth/github/device/poll?session=' + $started.data.sessionId)
    Assert ($login.code -eq 200 -and $login.data.status -eq 'ready' -and $login.data.token) '모의 중앙 로그인 완료 실패'
    $appToken = [string]$login.data.token; $sensitive.Add($appToken)
    # Seed only this new PC's encrypted session from the official login. Its storage key and user.home are isolated.
    $storageKey = [Guid]::NewGuid().ToString('N'); $sensitive.Add($storageKey)
    [IO.File]::WriteAllText((Join-Path $pcDir 'storage.key'), $storageKey, $utf8)
    $plain = @{ serverUrl = $serverUrl; mcpUrl = "$serverUrl/mcp"; login = $login.data.login; token = $appToken } | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($plain); $nonce = [Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
    $cipher = [byte[]]::new($bytes.Length); $tag = [byte[]]::new(16)
    $aes = [Security.Cryptography.AesGcm]::new([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($storageKey)), 16)
    try { $aes.Encrypt($nonce, $bytes, $cipher, $tag) } finally { $aes.Dispose() }
    [IO.File]::WriteAllText((Join-Path $pcDir 'server-session.enc'), [Convert]::ToBase64String([byte[]]($nonce + $cipher + $tag)), $utf8)
    $pc = Launch pc $desktopJar @("--server.port=$pcPort", "--flowlink.desktop.data-dir=$pcDir", '--flowlink.desktop.tray=false', '--flowlink.desktop.open-browser=false',
        '--flowlink.desktop.mcp-auto-configure=false', '--flowlink.execution.ssrf.allow-loopback=true')
    Ready $pc pc
    Assert ($deviceId -and $pcToken) '격리 PC 장치 식별자를 읽지 못했습니다.'
    $sensitive.Add($pcToken)
    $workspaces = Rest pc GET '/api/v1/workspaces'
    $personal = @($workspaces.data | Where-Object { $_.kind -eq 'PERSONAL' })
    Assert ($workspaces.code -eq 200 -and $personal.Count -eq 1) 'PC 개인 공간이 없습니다.'
    $pcSpace = [string]$personal[0].id
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $bridge = Rest server GET '/api/v1/desktop-bridge/status'
        if ($bridge.code -eq 200 -and $bridge.data.online) { break }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert ($bridge.data.online) '격리 PC outbound 연결이 없습니다.'
    $issued = Rest server POST '/api/v1/auth/mcp-tokens' @{ deviceId = $deviceId; clientId = 'vscode' }
    Assert ($issued.code -eq 200 -and $issued.data.accessToken -and $issued.data.tokenId) '격리 MCP 전용 자격 발급 실패'
    $mcpBearer = [string]$issued.data.accessToken; $mcpTokenId = [string]$issued.data.tokenId; $sensitive.Add($mcpBearer)
    $initialized = Rpc initialize @{ protocolVersion = $script:protocolVersion; capabilities = @{}; clientInfo = @{ name = 'flowlink-resource-smoke'; version = '1' } }
    Assert ($initialized.serverInfo.name -eq 'flowlink' -and $initialized.protocolVersion) 'MCP initialize 실패'
    $script:protocolVersion = [string]$initialized.protocolVersion
    Initialized-Notification
    $catalog = Rpc 'tools/list'
    Assert (@($catalog.tools).Count -eq 58) 'MCP 도구 목록은 58개여야 합니다.'
    $previewTool = @($catalog.tools | Where-Object name -eq 'protocol_preview')
    $frameDirections = @($previewTool[0].inputSchema.properties.frameDirection.enum | Sort-Object)
    Assert ($previewTool.Count -eq 1 -and ($frameDirections -join ',') -eq 'recv,send' -and 'frameDirection' -notin $previewTool[0].inputSchema.required) 'MCP 전문 미리보기의 선택적 요청/응답 프레임 방향이 없습니다.'
    $guide = Tool flowlink_guide @{ topic = 'flow' }
    Assert ($guide -match 'envSource|환경 출처|서버 공통') 'MCP 실행 가이드에 최신 자원 계약이 없습니다.'
    Checked 'initialize + tools/list 58 + guide'
    $protocolGuide = Tool flowlink_guide @{ topic = 'protocol' }
    Assert ($protocolGuide -match 'responseFraming' -and $protocolGuide -match 'idleTimeoutMs' -and $protocolGuide -match 'requestAckHex') 'MCP 프로토콜 가이드에 TCP 요청/응답 경계·연결 유지·ACK 계약이 없습니다.'
    Checked 'optional preview frameDirection enum + TCP protocol guide'

    $envName = 'mcp-shared-env'
    $null = Tool env_put @{ target = 'local'; name = $envName; vars = @{ ORIGIN = 'pc-marker' } }
    $null = Tool env_put @{ target = 'server'; name = $envName; vars = @{ ORIGIN = 'server-marker' } }
    $pcEnvs = @(Tool env_list @{ target = 'local' }); $serverEnvs = @(Tool env_list @{ target = 'server' })
    Assert (($pcEnvs | Where-Object name -eq $envName).vars.ORIGIN -eq 'pc-marker') '같은 이름의 PC 환경을 구분하지 못합니다.'
    Assert (($serverEnvs | Where-Object name -eq $envName).vars.ORIGIN -eq 'server-marker') '같은 이름의 서버 환경을 구분하지 못합니다.'
    Checked 'same-name PC/server environment stores'
    $secretCommon = 'mcp-common-' + [Guid]::NewGuid().ToString('N'); $secretOverlay = 'mcp-overlay-' + [Guid]::NewGuid().ToString('N')
    $localSecret = 'mcp-local-' + [Guid]::NewGuid().ToString('N')
    foreach ($secret in @($secretCommon, $secretOverlay, $localSecret)) { $sensitive.Add($secret) }
    Assert ((Rest server PUT '/api/v1/secrets/TOKEN?workspaceId=public' @{ value = $secretCommon }).code -eq 200) '공통 테스트 시크릿 저장 실패'
    Assert ((Rest server PUT '/api/v1/secrets/TOKEN?workspaceId=public' @{ value = $secretOverlay; environment = $envName }).code -eq 200) '서버 환경 테스트 시크릿 저장 실패'
    Assert ((Rest pc PUT "/api/v1/secrets/LOCAL_ONLY?workspaceId=$pcSpace" @{ value = $localSecret }).code -eq 200) 'PC legacy 시크릿 저장 실패'
    $secrets = @(Tool secret_list @{ target = 'local'; workspace = $pcSpace })
    Assert (@($secrets | Where-Object name -eq 'TOKEN').Count -eq 2 -and @($secrets | Where-Object name -eq 'LOCAL_ONLY').Count -eq 0) 'target local에서 서버 공통 시크릿 이름을 조회하지 못합니다.'
    $protocolSpec = @{ encoding = 'UTF-8'; lengthField = 'length'; includesSelf = $true; header = @(@{ name = 'length'; len = 4; type = 'length' }); messages = @(@{ key = 'request'; fields = @(@{ name = 'value'; len = 8; type = 'string' }) }) }
    $pcProtocol = Rest pc POST "/api/v1/protocols?workspaceId=$pcSpace" @{ name = 'mcp-wire'; spec = $protocolSpec; workspaceId = $pcSpace }
    Assert ($pcProtocol.code -eq 201) 'PC legacy 프로토콜 seed 실패'
    $centralProtocol = Tool protocol_upsert @{ target = 'local'; workspace = $pcSpace; name = 'mcp-wire'; spec = $protocolSpec }
    Assert ($centralProtocol.id -ne $pcProtocol.data.id) '중앙 도구가 PC 프로토콜을 덮어썼습니다.'
    $protocols = @(Tool protocol_list @{ target = 'local'; workspace = $pcSpace })
    Assert (@($protocols | Where-Object id -eq $centralProtocol.id).Count -eq 1 -and @($protocols | Where-Object id -eq $pcProtocol.data.id).Count -eq 0) 'target local의 공통 프로토콜 조회 실패'
    $source = "({id:'mcp-central-transform',label:'MCP 중앙 변환',inputs:[{key:'input'}],outputs:[{key:'result'}],params:[{key:'prefix'}],apply(inputs,config){return {result:config.prefix+'|'+inputs.input}}})"
    $plugin = Tool plugin_script_upsert @{ target = 'local'; workspace = $pcSpace; source = $source }
    $null = Tool plugin_script_submit @{ target = 'local'; id = $plugin.id }
    Assert ((Rest server POST "/api/v1/plugins/scripts/$($plugin.id)/approve?workspaceId=public").code -eq 200) '테스트용 중앙 변환 승인 실패'
    $preview = Tool transform_preview @{ target = 'local'; workspace = $pcSpace; id = 'mcp-central-transform'; inputs = @{ input = 'wire' }; config = @{ prefix = 'central' } }
    Assert ($preview.outputs.result -eq 'central|wire') 'target local 공통 변환 실행 실패'
    Checked 'common protocol/secret/plugin tools route to server public'

    $tcpSpec = @{ encoding = 'UTF-8'; discriminator = 'type'; header = @(@{ name = 'type'; len = 4; type = 'ascii' })
        framing = @{ mode = 'fixed'; fixedLength = 14 }; responseFraming = @{ mode = 'fixed'; fixedLength = 8 }
        transport = @{ connection = 'execution'; idleTimeoutMs = 30000; requestAckHex = '06'; responseAckHex = '06' }
        messages = @(@{ key = 'REQ1:request'; fields = @(@{ name = 'value'; len = 10; type = 'ascii' }) }, @{ key = 'RES1:response'; fields = @(@{ name = 'result'; len = 4; type = 'ascii' }) }) }
    $tcpProtocol = Tool protocol_upsert @{ target = 'local'; name = 'mcp-tcp-fixed'; spec = $tcpSpec }
    $tcpStored = Tool protocol_get @{ target = 'local'; id = $tcpProtocol.id }
    Assert ($tcpStored.spec.framing.fixedLength -eq 14 -and $tcpStored.spec.responseFraming.fixedLength -eq 8 -and $tcpStored.spec.transport.connection -eq 'execution' -and $tcpStored.spec.transport.idleTimeoutMs -eq 30000 -and $tcpStored.spec.transport.requestAckHex -eq '06' -and $tcpStored.spec.transport.responseAckHex -eq '06') 'MCP 저장·조회가 TCP 옵션을 보존하지 않습니다.'
    $tcpPreviewSend = Tool protocol_preview @{ protocolId = $tcpProtocol.id; key = 'REQ1:request'; values = @{ value = 'A001' }; frameDirection = 'send' }
    $tcpPreviewRecv = Tool protocol_preview @{ protocolId = $tcpProtocol.id; key = 'RES1:response'; values = @{ result = 'A001' }; frameDirection = 'recv' }
    $tcpPreviewDefault = Tool protocol_preview @{ protocolId = $tcpProtocol.id; key = 'REQ1:request'; values = @{ value = 'A001' } }
    Assert ($tcpPreviewSend.total -eq 14 -and @($tcpPreviewSend.errors).Count -eq 0 -and $tcpPreviewRecv.total -eq 8 -and @($tcpPreviewRecv.errors).Count -eq 0 -and $tcpPreviewDefault.total -eq 14 -and @($tcpPreviewDefault.errors).Count -eq 0) 'MCP 명시적 요청/응답 프레임 또는 기존 기본 SEND 조립이 잘못됐습니다.'
    Checked 'TCP options round-trip + request 14B / response 8B preview + default SEND'

    $tcpPort = Free-Port
    $tcpMock = Tool mock_upsert @{ target = 'local'; name = 'MCP PC fixed TCP'; slug = 'mcp-tcp-fixed'; type = 'TCP'; enabled = $true
        spec = @{ routes = @(); tcp = @{ port = $tcpPort; protocolId = $tcpProtocol.id; timeoutMs = 3000; rules = @(@{ id = 'echo'; when = @(); then = @{ mode = 'mock'; fields = @{ type = 'RES1'; result = '{{req.value}}' } } }) } } }
    $tcpSent = Tool mock_send @{ target = 'local'; slug = $tcpMock.slug; key = 'REQ1:request'; values = @{ value = 'A001' } }
    Assert ($tcpSent.request.total -eq 14 -and $tcpSent.response.bytes -eq 8 -and $tcpSent.response.body.result -eq 'A001') 'MCP mock_send의 실제 TCP 요청/응답 길이 또는 해석 결과가 잘못됐습니다.'
    $null = Tool mock_clear_log @{ target = 'local'; slug = $tcpMock.slug }
    Checked 'PC TCP Mock actual fixed 14B / 8B 4-way exchange'

    $tcpNode = @{ type = 'tcp'; executionAgent = 'local'; agentMock = $tcpMock.slug; protocolId = $tcpProtocol.id; tcpHost = '127.0.0.1'; tcpPort = $tcpPort; tcpTimeoutMs = 3000
        tcpMessage = 'REQ1:request'; tcpResponseMessage = 'RES1:response'; agentOutputs = @('type', 'result'); outputs = @(@{ key = 'result' }) }
    $tcpFirst = $tcpNode.Clone(); $tcpFirst.id = 'first'; $tcpFirst.tcpValues = @{ value = 'A001' }
    $tcpSecond = $tcpNode.Clone(); $tcpSecond.id = 'second'; $tcpSecond.tcpValues = @{ value = 'B002' }
    $tcpNodes = @(@{ id = 'start'; type = 'start' }, $tcpFirst, @{ id = 'hold1'; type = 'input'; waitFields = @(@{ key = 'go'; type = 'string' }) }, $tcpSecond, @{ id = 'hold2'; type = 'input'; waitFields = @(@{ key = 'go'; type = 'string' }) }, @{ id = 'end'; type = 'end' })
    $tcpEdges = @(); for ($i = 1; $i -lt $tcpNodes.Count; $i++) { $tcpEdges += @{ from = $tcpNodes[$i - 1].id; to = $tcpNodes[$i].id } }
    $tcpFlow = Tool flow_upsert @{ target = 'local'; name = 'MCP retained TCP'; graph = @{ nodes = $tcpNodes; edges = $tcpEdges } }
    $tcpRun = Tool flow_run @{ target = 'local'; id = $tcpFlow.flowId; timeoutSec = 45 }
    Assert ($tcpRun.execution.pendingInput.nodeId -eq 'hold1') 'MCP 첫 TCP 노드 이후 입력 대기에 도달하지 못했습니다.'
    $tcpFirstPorts = @(Get-NetTCPConnection -OwningProcess $pc.process.Id -RemotePort $tcpPort -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
    Assert ($tcpFirstPorts.Count -eq 1) '격리 PC의 첫 TCP 요청에 유지 연결이 없습니다.'
    $tcpHeld = Tool execution_resume @{ target = 'local'; id = $tcpRun.execution.id; values = @{ go = 'continue' }; timeoutSec = 45 }
    Assert ($tcpHeld.execution.pendingInput.nodeId -eq 'hold2') 'MCP 두 번째 TCP 노드 이후 입력 대기에 도달하지 못했습니다.'
    $tcpSecondPorts = @(Get-NetTCPConnection -OwningProcess $pc.process.Id -RemotePort $tcpPort -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
    Assert ($tcpSecondPorts.Count -eq 1 -and $tcpSecondPorts[0] -eq $tcpFirstPorts[0]) 'MCP 두 TCP 노드가 같은 실제 연결을 재사용하지 않습니다.'
    $tcpLogs = @(Tool mock_log @{ target = 'local'; slug = $tcpMock.slug; limit = 20 })
    Assert (@($tcpLogs | Where-Object { $_.dir -eq 'in' -and $_.key -eq 'REQ1' }).Count -eq 2 -and @($tcpLogs | Where-Object note -eq '요청 ACK').Count -eq 2 -and @($tcpLogs | Where-Object note -eq '응답 ACK').Count -eq 2) 'MCP TCP 노드의 실제 요청 두 개 또는 4-way ACK 로그가 없습니다.'
    $tcpDone = Tool execution_resume @{ target = 'local'; id = $tcpRun.execution.id; values = @{ go = 'finish' }; timeoutSec = 45 }
    $tcpOutputs = @($tcpDone.execution.nodes | Where-Object nodeId -in @('first', 'second') | ForEach-Object { $_.output.result })
    Assert ($tcpDone.execution.status -eq 'SUCCEEDED' -and ($tcpOutputs -join ',') -eq 'A001,B002') 'MCP TCP 두 요청의 워크플로 결과가 잘못됐습니다.'
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    do {
        $tcpOpen = @(Get-NetTCPConnection -OwningProcess $pc.process.Id -RemotePort $tcpPort -State Established -ErrorAction SilentlyContinue)
        if (!$tcpOpen.Count) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert ($tcpOpen.Count -eq 0) 'MCP 워크플로 완료 후 유지 TCP 연결이 남습니다.'
    Checked 'MCP flow_run/resume reuses physical TCP port + two 4-way requests + completion closes socket'

    $slug = 'mcp-echo'
    $echoSpec = @{ environment = $envName; routes = @(@{ id = 'echo-route'; method = 'POST'; path = '/echo'; rules = @(@{ id = 'echo-rule'; when = @(); status = 200; contentType = 'json'; body = '{"origin":"{{body.origin}}","token":"{{body.token}}"}' }) }) }
    $mock = Tool mock_upsert @{ target = 'local'; name = 'MCP PC echo'; slug = $slug; type = 'HTTP'; enabled = $true; spec = $echoSpec }
    Assert ($mock.spec.resourceWorkspaceId -eq 'public' -and $mock.spec.envSource -eq 'local') '새 PC Mock에 중앙 자원 기본 계약이 없습니다.'
    $inventory = Tool mock_list @{ target = 'server' }
    Assert (@($inventory.mocks | Where-Object { $_.id -eq $mock.id -and $_.target -eq 'local' }).Count -eq 1) '서버 Mock 목록에서 내 PC Mock이 사라졌습니다.'
    Assert (@($inventory.sources | Where-Object { $_.target -eq 'local' -and $_.available }).Count -eq 1 -and @($inventory.sources | Where-Object { $_.target -eq 'server' -and $_.available }).Count -eq 1) 'Mock 목록의 양쪽 출처 상태가 없습니다.'
    Checked 'combined Mock list retains PC while browsing server'
    $graph = @{ nodes = @(@{ id = 'start'; type = 'start' }, @{ id = 'request'; type = 'http'; executionAgent = 'local'; method = 'POST'; baseUrl = "http://localhost:$pcPort$($mock.basePath)"; path = '/echo'; bodyType = 'json'; jsonRaw = $true; rawBody = '{"origin":"{{ ORIGIN@env }}","token":"{{ TOKEN@secret }}"}'; respType = 'json'; outputs = @(@{ key = 'origin' }, @{ key = 'token' }) }, @{ id = 'transform'; type = 'transform'; transformId = 'mcp-central-transform'; fields = @{ body = @(@{ key = 'input'; value = '{{ origin@request }}' }) }; outputs = @(@{ key = 'result' }); config = @{ prefix = '{{ ORIGIN@env }}' } }, @{ id = 'end'; type = 'end' }); edges = @(@{ from = 'start'; to = 'request' }, @{ from = 'request'; to = 'transform' }, @{ from = 'transform'; to = 'end' }) }
    $flow = Tool flow_upsert @{ target = 'local'; name = 'MCP PC resource flow'; graph = $graph }
    $saved = Tool flow_get @{ target = 'local'; id = $flow.flowId }
    Assert ($saved.graph.resourceWorkspaceId -eq 'public') '새 흐름 graph public 계약이 없습니다.'
    $pcRun = Tool flow_run @{ target = 'local'; id = $flow.flowId; envName = $envName; envSource = 'local'; timeoutSec = 45 }
    Successful $pcRun 'pc-marker'
    $serverEnvRun = Tool flow_run @{ target = 'local'; id = $flow.flowId; envName = $envName; envSource = 'server'; timeoutSec = 45 }
    Successful $serverEnvRun 'server-marker'
    Checked 'PC HTTP echo + central transform + both env sources + masked bodies'
    $serverFlow = Tool flow_upsert @{ target = 'server'; name = 'MCP server owner PC request'; graph = $graph }
    $delegated = Tool flow_run @{ target = 'server'; id = $serverFlow.flowId; envName = $envName; envSource = 'local'; timeoutSec = 45 }
    Successful $delegated 'pc-marker'
    Checked 'server-owned flow with PC environment and delegated PC HTTP'
    $rerun = Tool execution_rerun @{ target = 'local'; id = $serverEnvRun.execution.id; timeoutSec = 45 }
    Successful $rerun 'server-marker'
    Assert ($rerun.execution.flowVersionId -eq $serverEnvRun.execution.flowVersionId) '재실행이 원본 버전을 유지하지 않습니다.'
    Checked 'rerun preserves original server environment source and graph version'

    $legacyGraph = @{ nodes = @(@{ id = 'start'; type = 'start' }, @{ id = 'end'; type = 'end' }); edges = @(@{ from = 'start'; to = 'end' }) }
    $legacyFlow = Rest pc POST '/api/v1/flows' @{ name = 'MCP legacy PC flow'; workspaceId = $pcSpace }
    Assert ($legacyFlow.code -eq 201) 'legacy 테스트 흐름 생성 실패'
    Assert ((Rest pc POST "/api/v1/flows/$($legacyFlow.data.id)/versions?workspaceId=$pcSpace" @{ graph = $legacyGraph }).code -eq 201) 'legacy 그래프 저장 실패'
    $null = Tool flow_upsert @{ target = 'local'; id = $legacyFlow.data.id; graph = $legacyGraph }
    $legacySaved = Tool flow_get @{ target = 'local'; id = $legacyFlow.data.id }
    No-Metadata $legacySaved.graph 'flow_upsert'
    $legacyMock = Rest pc POST '/api/v1/mock-servers' @{ name = 'MCP legacy PC Mock'; slug = 'mcp-legacy'; type = 'HTTP'; workspaceId = $pcSpace }
    Assert ($legacyMock.code -eq 201) 'legacy 테스트 Mock 생성 실패'
    Assert ((Rest pc PUT "/api/v1/mock-servers/$($legacyMock.data.id)/spec?workspaceId=$pcSpace" @{ spec = @{ routes = @() } }).code -eq 200) 'legacy Mock 명세 저장 실패'
    $legacyUpdated = Tool mock_upsert @{ target = 'local'; name = 'MCP legacy PC Mock'; slug = 'mcp-legacy'; type = 'HTTP'; spec = @{ routes = @() }; enabled = $false }
    No-Metadata $legacyUpdated.spec 'mock_upsert'
    Checked 'legacy flow/spec metadata stays absent on MCP edit'
    $storedTokens = [IO.File]::ReadAllText($registry)
    Assert (!$storedTokens.Contains($mcpBearer) -and !$storedTokens.Contains($appToken)) '중앙 등록 파일에 원본 자격이 저장됩니다.'
    Checked 'hash-only MCP credential registry'
    $passed = $true
} catch {
    $failureReason = Redact $_.Exception.Message
    Write-Host "FAIL: $stage — $failureReason"
} finally {
    if ($mcpTokenId -and $appToken) {
        try {
            $revoked = Rest server DELETE "/api/v1/auth/mcp-tokens/$mcpTokenId"
            Assert ($revoked.code -eq 204) '새 MCP 자격을 폐기하지 못했습니다.'
            $checks.Add('new isolated MCP credential revoked')
        } catch { $cleanupPassed = $false; Write-Host 'FAIL: isolated MCP credential revoke' }
    }
    # Kill only the processes created by this script, including any outstanding long-poll worker.
    for ($i = $runs.Count - 1; $i -ge 0; $i--) {
        $run = $runs[$i]
        try { $run.process.Refresh(); if (!$run.process.HasExited) { $run.process.Kill($true); if (!$run.process.WaitForExit(10000)) { $cleanupPassed = $false } } }
        catch { $cleanupPassed = $false }
    }
    foreach ($run in $runs) {
        try {
            foreach ($stream in @('out', 'err')) {
                $text = '프로세스 출력 수집 시간 초과'
                if ($run[$stream].Wait(5000)) { $text = Redact $run[$stream].GetAwaiter().GetResult() } else { $cleanupPassed = $false }
                $suffix = if ($stream -eq 'out') { 'stdout' } else { 'stderr' }
                [IO.File]::WriteAllText((Join-Path $lab ($run.role + '.' + $suffix + '.log')), $text, $utf8)
            }
        } catch {
            $cleanupPassed = $false
        } finally { $run.process.Dispose() }
    }
    $result = @{ passed = $passed -and $cleanupPassed; mcpProtocolTested = $true; expectedToolCount = 58; negotiatedProtocolVersion = $script:protocolVersion; checks = @($checks); failurePhase = if ($passed) { $null } else { $stage }; failureReason = $failureReason; cleanupPassed = $cleanupPassed; serverPort = $serverPort; pcPort = $pcPort; isolatedDirectory = $lab; userDataTouched = $false; ideAutoConfigure = $false }
    [IO.File]::WriteAllText((Join-Path $lab 'results.json'), ($result | ConvertTo-Json -Depth 8), $utf8)
}
Assert ($passed -and $cleanupPassed) "MCP resource smoke 실패. 비밀값을 지운 results/log를 확인하세요: $lab"
Write-Host "PASS: 실제 MCP 자원·환경·위임·재실행 wire 검증 ($lab)"
