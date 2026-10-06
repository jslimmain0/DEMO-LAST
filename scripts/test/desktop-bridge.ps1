#Requires -Version 7
param([string]$JavaHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$serverJar = Join-Path $repo 'backend/flow-server/build/libs/flowlink-server.jar'
$desktopJar = Join-Path $repo 'backend/flow-desktop/build/libs/flowlink-desktop.jar'
foreach ($jar in @($serverJar, $desktopJar)) { if (!(Test-Path -LiteralPath $jar)) { throw '먼저 server/desktop bootJar를 빌드하세요.' } }
if (!$JavaHome) { $JavaHome = Join-Path $env:USERPROFILE '.jdks/corretto-21.0.10' }
$java = Join-Path $JavaHome 'bin/java.exe'
if (!(Test-Path -LiteralPath $java)) { throw 'Java 21 경로가 필요합니다.' }
$lab = Join-Path $repo ('.run/desktop-bridge-' + [Guid]::NewGuid().ToString('N'))
$pcDir = Join-Path $lab 'pc'
New-Item -ItemType Directory -Path $pcDir -Force | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
function Free-Port {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
$serverPort = Free-Port
do { $pcPort = Free-Port } while ($pcPort -eq $serverPort)
$serverUrl = "http://127.0.0.1:$serverPort"
$pcUrl = "http://127.0.0.1:$pcPort"
$seed = [Guid]::NewGuid().ToString('N')
function B64Url([byte[]]$bytes) { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
function Test-Jwt([string]$user) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = B64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
    $payload = @{ sub=$user; preferred_username=$user; tenant='default'; iss='flowlink'; iat=$now; exp=$now+3600; realm_access=@{roles=@('admin','editor','platform-admin')} } | ConvertTo-Json -Compress -Depth 8
    $content = $header + '.' + (B64Url ([Text.Encoding]::UTF8.GetBytes($payload)))
    $hmac = [Security.Cryptography.HMACSHA256]::new([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($seed)))
    try { return $content + '.' + (B64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($content)))) } finally { $hmac.Dispose() }
}
$caller = Test-Jwt 'bridge-lab'
$other = Test-Jwt 'bridge-other'
$offline = Test-Jwt 'bridge-offline'
# Seed only this isolated PC's encrypted test login; no GitHub/OAuth interaction.
$storage = [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText((Join-Path $pcDir 'storage.key'), $storage, $utf8)
$plain = @{serverUrl=$serverUrl; mcpUrl="$serverUrl/mcp"; login='bridge-lab'; token=$caller} | ConvertTo-Json -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$nonce = [Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
$cipher = [byte[]]::new($bytes.Length); $tag = [byte[]]::new(16)
$aes = [Security.Cryptography.AesGcm]::new([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($storage)), 16)
try { $aes.Encrypt($nonce, $bytes, $cipher, $tag) } finally { $aes.Dispose() }
[IO.File]::WriteAllText((Join-Path $pcDir 'server-session.enc'), [Convert]::ToBase64String([byte[]]($nonce+$cipher+$tag)), $utf8)
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
function Launch([string]$role, [string]$jar, [string[]]$arguments, [hashtable]$environment) {
    $info = [Diagnostics.ProcessStartInfo]::new($java)
    $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $info.WorkingDirectory=$lab
    foreach ($key in @($info.Environment.Keys)) { if ($key -match '^(FLOWLINK_|SPRING_|SERVER_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$)') { $info.Environment.Remove($key) | Out-Null } }
    foreach ($key in $environment.Keys) { $info.Environment[$key] = [string]$environment[$key] }
    foreach ($arg in @('-jar',$jar)+$arguments) { $info.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($info); $processes.Add($process)
    # Drain both streams asynchronously; preserve isolated logs without displaying credentials.
    $out = $process.StandardOutput.ReadToEndAsync(); $err = $process.StandardError.ReadToEndAsync()
    return @{process=$process; out=$out; err=$err; role=$role}
}
function Call([string]$method, [string]$path, [string]$token, $body=$null) {
    $params = @{Uri=$serverUrl+$path; Method=$method; Headers=@{Authorization="Bearer $token"}; SkipHttpErrorCheck=$true; TimeoutSec=10}
    if ($null -ne $body) { $params.Body=$body|ConvertTo-Json -Compress -Depth 40; $params.ContentType='application/json' }
    $response = Invoke-WebRequest @params
    $json = if ($response.Content) { $response.Content | ConvertFrom-Json -Depth 40 } else { $null }
    return @{code=[int]$response.StatusCode; json=$json}
}
function Assert([bool]$condition, [string]$message) { if (!$condition) { throw $message } }
function Ready([string]$url, [Diagnostics.Process]$process) {
    for ($i=0; $i -lt 120; $i++) {
        if ($process.HasExited) { throw '격리 앱이 준비 전에 종료되었습니다. 보존한 로그를 확인하세요.' }
        try {
            $headers = @{}
            if ($url -eq $pcUrl) {
                $agentFile = Join-Path $pcDir 'agent.json'
                if (!(Test-Path -LiteralPath $agentFile)) { Start-Sleep -Milliseconds 500; continue }
                $agent = [IO.File]::ReadAllText($agentFile) | ConvertFrom-Json
                $headers['X-FlowLink-Local'] = $agent.token
            }
            if ((Invoke-WebRequest "$url/actuator/health" -Headers $headers -SkipHttpErrorCheck -TimeoutSec 2).StatusCode -eq 200) { return }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw '격리 앱 준비 시간 초과'
}
$runs = @()
try {
    $runs += Launch 'server' $serverJar @('--spring.profiles.active=local',"--server.port=$serverPort",'--server.address=127.0.0.1',"--spring.datasource.url=jdbc:h2:file:$lab/serverdb;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",'--flowlink.auth.github-enabled=true',"--flowlink.auth.jwt-secret=$seed",'--flowlink.vault.enabled=false','--flowlink.vault.transit.enabled=false',"--flowlink.plugins.dir=$lab/server-plugins") @{}
    Ready $serverUrl $runs[0].process
    $runs += Launch 'pc' $desktopJar @("--server.port=$pcPort", "--flowlink.desktop.data-dir=$pcDir",'--flowlink.desktop.tray=false') @{}
    Ready $pcUrl $runs[1].process
    for ($i=0; $i -lt 40; $i++) {
        $status = Call GET '/api/v1/desktop-bridge/status' $caller
        if ($status.json.online) { break }
        Start-Sleep -Milliseconds 500
    }
    Assert ($status.code -eq 200 -and $status.json.online) 'PC outbound 연결이 확인되지 않았습니다.'
    $id = [Guid]::NewGuid().ToString()
    $command = @{requestId=$id; method='GET'; path='/api/v1/workspaces'}
    $submitted = Call POST '/api/v1/desktop-bridge/requests' $caller $command
    Assert ($submitted.code -eq 200) '개인 workspace 조회 요청 접수 실패'
    for ($i=0; $i -lt 60; $i++) {
        $result = Call GET "/api/v1/desktop-bridge/requests/$id" $caller
        if ($result.json.status -notin @('PENDING','RUNNING')) { break }
        Start-Sleep -Milliseconds 300
    }
    Assert ($result.json.status -eq 'SUCCEEDED' -and $result.json.httpStatus -eq 200) 'PC 개인 workspace 실응답 실패'
    $personal = @($result.json.body | Where-Object { $_.kind -eq 'PERSONAL' })
    Assert ($personal.Count -ge 1) '개인 H2 workspace를 확인할 수 없습니다.'
    $again = Call POST '/api/v1/desktop-bridge/requests' $caller $command
    Assert ($again.json.status -eq 'SUCCEEDED') '동일 requestId 결과 재조회 실패'
    $hidden = Call GET "/api/v1/desktop-bridge/requests/$id" $other
    Assert ($hidden.code -ne 200) '다른 계정에 개인 결과가 노출됩니다.'
    Write-Host ('계정 격리 HTTP: ' + $hidden.code + ' (기대404)')
    $absent = Call POST '/api/v1/desktop-bridge/requests' $offline @{requestId=[Guid]::NewGuid().ToString();method='GET';path='/api/v1/workspaces'}
    Write-Host ('오프라인 HTTP: ' + $absent.code + ' (기대409)')
    # A separate synthetic identity claims a read, then reconnects. No mutation or real account.
    $connection = Call POST '/api/v1/desktop-bridge/connect' $other @{deviceId='isolated-fence-pc'}
    $fenceId=[Guid]::NewGuid().ToString()
    $fenceCommand=@{requestId=$fenceId;method='GET';path='/api/v1/workspaces'}
    $null=Call POST '/api/v1/desktop-bridge/requests' $other $fenceCommand
    $headers=@{Authorization="Bearer $other";'X-FlowLink-PC-Session'=$connection.json.sessionId;'X-FlowLink-PC-Key'=$connection.json.credential}
    $claimed=Invoke-RestMethod "$serverUrl/api/v1/desktop-bridge/poll" -Method Post -Headers $headers
    Assert (@($claimed).Count -eq 1) '합성 세션 claim 실패'
    $null=Call POST '/api/v1/desktop-bridge/connect' $other @{deviceId='isolated-fence-pc'}
    $unknown=Call POST '/api/v1/desktop-bridge/requests' $other $fenceCommand
    Assert ($unknown.json.status -eq 'UNKNOWN') '재연결 후 불명확 요청이 재전달됩니다.'
    [IO.File]::WriteAllText((Join-Path $lab 'results.json'), (@{passed=($hidden.code -eq 404 -and $absent.code -eq 409);accountIsolationStatus=$hidden.code;offlineStatus=$absent.code;checks=@('actual-PC-personal-H2-response','same-ID-result','account-isolation','offline-409','reconnect-UNKNOWN');serverPort=$serverPort;pcPort=$pcPort}|ConvertTo-Json -Depth 5),$utf8)
    Assert ($hidden.code -eq 404 -and $absent.code -eq 409) '계정 격리/오프라인 HTTP 계약 불일치(격리 results.json 확인)'
    Write-Host 'PASS: 실제 PC 개인 H2 조회 / 동일 ID / 계정 격리 / offline409 / reconnect UNKNOWN'
    Write-Host "격리 결과: $lab"
} finally {
    foreach ($process in $processes) { if (!$process.HasExited) { $process.Kill($true); $process.WaitForExit(10000) | Out-Null } }
    foreach ($run in $runs) {
        [IO.File]::WriteAllText((Join-Path $lab ($run.role+'.stdout.log')), $run.out.GetAwaiter().GetResult(), $utf8)
        [IO.File]::WriteAllText((Join-Path $lab ($run.role+'.stderr.log')), $run.err.GetAwaiter().GetResult(), $utf8)
    }
}
