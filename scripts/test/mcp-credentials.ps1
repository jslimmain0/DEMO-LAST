#Requires -Version 7
# Central credential management REST only; never calls /mcp, tools, IDE registration or real GitHub.
param([string]$JavaHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$jar = Join-Path $repo 'backend/flow-server/build/libs/flowlink-server.jar'
if (!(Test-Path -LiteralPath $jar)) { throw '먼저 server bootJar를 빌드하세요.' }
if (!$JavaHome) { $JavaHome = Join-Path $env:USERPROFILE '.jdks/corretto-21.0.10' }
$java = Join-Path $JavaHome 'bin/java.exe'
$lab = Join-Path $repo ('.run/mcp-credentials-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $lab -Force | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$url = "http://127.0.0.1:$port"
$registry = Join-Path $lab 'tokens.json'
$labSigningKey = [Guid]::NewGuid().ToString('N')
$process = $null
$runs = [Collections.Generic.List[object]]::new()
function Assert([bool]$condition, [string]$message) { if (!$condition) { throw $message } }
function Launch {
    $info = [Diagnostics.ProcessStartInfo]::new($java)
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.WorkingDirectory=$lab
    foreach ($key in @($info.Environment.Keys)) { if ($key -match '^(FLOWLINK_|SPRING_|SERVER_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$)') { [void]$info.Environment.Remove($key) } }
    $launchArguments = @("-Duser.home=$lab", '-jar', $jar, '--spring.profiles.active=local,agent-lab', "--server.port=$port",
        '--server.address=127.0.0.1', "--spring.datasource.url=jdbc:h2:file:$lab/db;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
        '--flowlink.auth.github-enabled=true', "--flowlink.auth.jwt-secret=$labSigningKey", '--flowlink.vault.enabled=false', '--flowlink.vault.transit.enabled=false',
        "--flowlink.plugins.dir=$lab/plugins", "--flowlink.mcp.tokens-file=$registry", "--flowlink.mcp.clients-file=$lab/clients.json")
    foreach ($arg in $launchArguments) { $info.ArgumentList.Add($arg) }
    $proc = [Diagnostics.Process]::Start($info)
    $runs.Add(@{process=$proc; out=$proc.StandardOutput.ReadToEndAsync(); err=$proc.StandardError.ReadToEndAsync()})
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($proc.HasExited) { throw '격리 서버 기동 실패. 저장된 로그를 확인하세요.' }
        try { if ((Invoke-WebRequest "$url/api/v1/auth/config" -SkipHttpErrorCheck -TimeoutSec 2).StatusCode -eq 200) { return $proc } } catch {}
        Start-Sleep -Milliseconds 300
    }
    throw '격리 서버 기동 시간 초과'
}
function Call([string]$method, [string]$path, [string]$token='', $body=$null) {
    $params = @{Uri=$url+$path; Method=$method; SkipHttpErrorCheck=$true; TimeoutSec=10; Headers=@{}}
    if ($token) { $params.Headers['Authorization'] = "Bearer $token" }
    if ($null -ne $body) { $params.Body=$body|ConvertTo-Json -Compress; $params.ContentType='application/json' }
    $response = Invoke-WebRequest @params
    return @{code=[int]$response.StatusCode; json=if ($response.Content) { $response.Content|ConvertFrom-Json } else { $null } }
}
function Login {
    $start = Call POST '/api/v1/auth/github/device/start'
    Assert ($start.code -eq 200) '모의 중앙 로그인 시작 실패'
    $poll = Call GET ('/api/v1/auth/github/device/poll?session=' + $start.json.sessionId)
    Assert ($poll.code -eq 200 -and $poll.json.status -eq 'ready') '모의 중앙 로그인 완료 실패'
    return [string]$poll.json.token
}
function Internal-Device-Jwt([string]$device) {
    function B64Url([byte[]]$bytes) { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = B64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
    $payload = @{sub='lab-admin';preferred_username='lab-admin';tenant='default';iss='flowlink';purpose='app';iat=$now;exp=$now+300;mcp_device=$device} | ConvertTo-Json -Compress
    $content = $header + '.' + (B64Url ([Text.Encoding]::UTF8.GetBytes($payload)))
    $hmac = [Security.Cryptography.HMACSHA256]::new([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($labSigningKey)))
    try { return $content + '.' + (B64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($content)))) } finally { $hmac.Dispose() }
}
try {
    $process = Launch
    Assert ((Call POST '/api/v1/auth/mcp-tokens' '' @{deviceId='test-pc';clientId='vscode'}).code -eq 401) '무인증 토큰 발급이 열려 있습니다'
    $source = Login
    $other = Login
    $first = Call POST '/api/v1/auth/mcp-tokens' $source @{deviceId='test-pc';clientId='vscode'}
    Assert ($first.code -eq 200 -and $first.json.accessToken) 'MCP 전용 토큰 발급 실패'
    Assert ((Call GET '/api/v1/auth/me' $first.json.accessToken).code -eq 401) 'MCP 토큰이 일반 관리 API에 사용됩니다'
    Assert ((Call POST '/api/v1/auth/mcp-tokens' $source @{deviceId='test-pc';clientId='unknown'}).code -eq 400) '알 수 없는 IDE 유형을 거부하지 않습니다'
    Assert ((Call POST "/api/v1/auth/mcp-tokens/$($first.json.tokenId)/refresh" $other).code -eq 404) '다른 로그인 세션이 토큰을 갱신합니다'
    $refreshed = Call POST "/api/v1/auth/mcp-tokens/$($first.json.tokenId)/refresh" $source
    Assert ($refreshed.code -eq 200 -and $refreshed.json.tokenId -eq $first.json.tokenId -and $refreshed.json.accessToken -ne $first.json.accessToken) '토큰 갱신과 연결 ID 유지 실패'
    $second = Call POST '/api/v1/auth/mcp-tokens' $other @{deviceId='test-pc-2';clientId='intellij'}
    Assert ($second.code -eq 200) '다른 로그인 세션의 IDE 토큰 발급 실패'
    $stored = [IO.File]::ReadAllText($registry)
    foreach ($secret in @($source,$other,$first.json.accessToken,$refreshed.json.accessToken,$second.json.accessToken)) {
        Assert (!$stored.Contains($secret)) '발급한 원본 토큰이 중앙 등록 파일에 저장됩니다'
    }
    Stop-Process -Id $process.Id -Force; [void]$process.WaitForExit(10000)
    $process = Launch
    $afterRestart = Call POST "/api/v1/auth/mcp-tokens/$($refreshed.json.tokenId)/refresh" $source
    Assert ($afterRestart.code -eq 200) '서버 재시작 후 기존 로그인과 연결 등록 유지 실패'
    Assert ((Call DELETE '/api/v1/auth/mcp-tokens' $source).code -eq 204) '로그아웃용 세션 연결 폐기 실패'
    Assert ((Call POST "/api/v1/auth/mcp-tokens/$($first.json.tokenId)/refresh" $source).code -eq 404) '폐기된 연결이 갱신됩니다'
    Assert ((Call POST "/api/v1/auth/mcp-tokens/$($second.json.tokenId)/refresh" $other).code -eq 200) '로그아웃이 다른 로그인 세션까지 폐기합니다'
    # Test the internal claim boundary via ordinary bridge REST, never the MCP protocol.
    Assert ((Call POST '/api/v1/desktop-bridge/connect' $source @{deviceId='pc-B'}).code -eq 200) '격리 PC 연결 등록 실패'
    $deviceA = Internal-Device-Jwt 'pc-A'; $deviceB = Internal-Device-Jwt 'pc-B'
    $commandId = [Guid]::NewGuid().ToString()
    $command = @{requestId=$commandId;method='GET';path='/api/v1/workspaces'}
    Assert ((Call POST '/api/v1/desktop-bridge/requests' $deviceA $command).code -eq 409) '다른 PC로 개인 명령이 잘못 전달됩니다'
    Assert ((Call POST '/api/v1/desktop-bridge/requests' $deviceB $command).code -eq 200) '일치하는 PC의 개인 명령 접수 실패'
    Assert ((Call GET "/api/v1/desktop-bridge/requests/$commandId" $deviceA).code -eq 409) '다른 PC의 개인 결과가 표시됩니다'
    Assert ((Call GET "/api/v1/desktop-bridge/requests/$commandId" $deviceB).code -eq 200) '일치하는 PC의 개인 결과 조회 실패'
    $result = @{passed=$true;checks=@('unauthenticated401','issue','management401','unsupported400','sessionIsolation404','rotate','hashOnly','restart','logout','otherSessionPreserved','deviceSubmit409','deviceResult409','matchingDevice');mcpProtocolTested=$false}
    [IO.File]::WriteAllText((Join-Path $lab 'results.json'), ($result|ConvertTo-Json -Depth 5))
    Write-Output "PASS: 중앙 모의 로그인·MCP 자격증명 발급/갱신/폐기·관리 API 차단·세션 격리·재시작 유지 ($lab)"
} finally {
    foreach ($run in $runs) {
        $run.process.Refresh()
        if (!$run.process.HasExited) { Stop-Process -Id $run.process.Id -Force; [void]$run.process.WaitForExit(10000) }
        [IO.File]::WriteAllText((Join-Path $lab ('stdout-' + $run.process.Id + '.log')), $run.out.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $lab ('stderr-' + $run.process.Id + '.log')), $run.err.GetAwaiter().GetResult())
        $run.process.Dispose()
    }
}
