param(
    [string]$JavaHome = $env:JAVA_HOME,
    [int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (-not $JavaHome) { $JavaHome = Join-Path $env:USERPROFILE '.jdks/corretto-21.0.10' }
$java = Join-Path $JavaHome 'bin/java.exe'
if (-not (Test-Path -LiteralPath $java)) { throw 'Java 21 JAVA_HOME을 지정하세요.' }
$versionErrorAction = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { $javaVersion = (& $java -version 2>&1 | Out-String) } finally { $ErrorActionPreference = $versionErrorAction }
if ($javaVersion -notmatch 'version "21[.\"]') { throw 'Java 21이 필요합니다.' }
$work = Join-Path $repo ('.run/module-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force > $null
$processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$client = [System.Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromSeconds(30)
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Free-Port {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}
function Start-App([string]$Role, [string]$Name, [string[]]$Extra) {
    $jar = Join-Path $repo "backend/flow-$Role/build/libs/flowlink-$Role.jar"
    Require (Test-Path -LiteralPath $jar) "$Role JAR이 없습니다."
    $port = Free-Port
    $data = Join-Path $work $Name
    New-Item -ItemType Directory -Path $data -Force > $null
    $arguments = @('-jar', $jar, "--server.port=$port", "--flowlink.desktop.data-dir=$data", '--flowlink.desktop.tray=false', '--flowlink.desktop.open-browser=false', '--flowlink.auth.github-enabled=false', "--logging.file.name=$data/runtime.log", "--flowlink.plugins.dir=$data/plugins")
    if ($Role -eq 'server') {
        $db = (Join-Path $data 'db/flowlink').Replace('\','/')
        $arguments += @('--spring.profiles.active=local', "--spring.datasource.url=jdbc:h2:file:$db;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE")
    }
    $arguments += $Extra
    # Every argument is a literal process argument, never evaluated as a shell command.
    $quoted = $arguments | ForEach-Object { '"' + $_ + '"' }
    $proc = Start-Process -FilePath $java -ArgumentList $quoted -WindowStyle Hidden -PassThru -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $data 'stdout.log') -RedirectStandardError (Join-Path $data 'stderr.log')
    $processes.Add($proc)
    return @{ Process = $proc; Port = $port; Data = $data; Role = $Role; Base = "http://127.0.0.1:$port" }
}
function Request($App, [string]$Path, [string]$Token = '', [string]$Method = 'GET', $Body = $null) {
    $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), ($App.Base + $Path))
    if ($Token) { [void]$req.Headers.TryAddWithoutValidation('X-FlowLink-Local', $Token) }
    if ($null -ne $Body) { $req.Content = [System.Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 10), [System.Text.Encoding]::UTF8, 'application/json') }
    try {
        $res = $client.SendAsync($req).GetAwaiter().GetResult()
        try { return @{ Status = [int]$res.StatusCode; Body = $res.Content.ReadAsStringAsync().GetAwaiter().GetResult() } }
        finally { $res.Dispose() }
    } finally { $req.Dispose() }
}
function Wait-Ready($App) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $App.Process.Refresh()
        Require (-not $App.Process.HasExited) '격리 앱이 기동 전에 종료됐습니다. 해당 smoke 로그를 확인하세요.'
        try { $r = Request $App '/api/v1/auth/config'; if ($r.Status -eq 200 -or ($App.Role -eq 'desktop' -and $r.Status -eq 401)) { return $r } } catch { }
        Start-Sleep -Milliseconds 300
    }
    throw '격리 앱 기동 시간이 초과됐습니다.'
}
function Require-Rejection($App, [string]$Marker) {
    Require ($App.Process.WaitForExit($TimeoutSeconds * 1000)) '잘못된 launcher 인자를 거부하지 않았습니다.'
    Require ($App.Process.ExitCode -ne 0) '잘못된 launcher 인자가 성공 종료했습니다.'
    $logs = (Get-Content (Join-Path $App.Data 'stdout.log') -Raw) + (Get-Content (Join-Path $App.Data 'stderr.log') -Raw)
    Require ($logs -match $Marker) '예상 launcher 보호 사유가 로그에 없습니다.'
}
try {
    $server = Start-App 'server' 'server' @()
    $config = (Wait-Ready $server).Body | ConvertFrom-Json
    Require ($config.runtime.kind -eq 'server') '서버 launcher가 개인 runtime으로 기동했습니다.'
    Require ((Request $server '/api/v1/auth/github/device/poll?session=module-boundary').Status -eq 200) '서버에 중앙 로그인 발급 API가 없습니다.'
    Require ((Request $server '/api/v1/distribution').Status -eq 200) '서버 distribution API가 없습니다.'
    foreach ($path in @('/', '/index.html', '/flows', '/plugins')) {
        Require ((Request $server $path).Status -eq 404) "중앙 서버가 작업 프론트를 제공합니다: $path"
    }
    $desktop = Start-App 'desktop' 'desktop' @()
    [void](Wait-Ready $desktop)
    $agentFile = Join-Path $desktop.Data 'agent.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $agentFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    Require (Test-Path -LiteralPath $agentFile) '격리 개인 session이 게시되지 않았습니다.'
    $agent = Get-Content -LiteralPath $agentFile -Raw | ConvertFrom-Json
    Require ($agent.baseUrl -eq $desktop.Base) '개인 session 포트가 launcher와 다릅니다.'
    $config = (Request $desktop '/api/v1/auth/config' $agent.token).Body | ConvertFrom-Json
    Require ($config.runtime.kind -eq 'local') 'desktop launcher가 개인 runtime이 아닙니다.'
    $screen = Request $desktop '/plugins' $agent.token
    Require ($screen.Status -eq 200 -and $screen.Body -match '<div id="root">') 'desktop에 작업 프론트의 딥링크가 없습니다.'
    Require ((Request $desktop '/api/v1/auth/github/device/poll?session=module-boundary' $agent.token).Status -eq 404) 'desktop에 중앙 로그인 발급 API가 등록됐습니다.'
    Require ((Request $desktop '/api/v1/flows').Status -eq 401) '개인 API 접근 보호가 없습니다.'
    $distribution = Request $desktop '/api/v1/distribution' $agent.token
    if ($distribution.Status -ne 404) {
        # Only classify known generic errors; never print arbitrary response bodies or credentials.
        $classification = '일반 오류 응답 또는 예상 밖 성공'
        try {
            $errorMessage = ($distribution.Body | ConvertFrom-Json).message
            if ($errorMessage -eq '예상치 못한 오류: NoResourceFoundException') { $classification = 'NoResourceFoundException 공통500 변환' }
            elseif ($errorMessage -match '^서버 내부 오류') { $classification = '공통 내부 오류 안내' }
            elseif ($errorMessage -match '^No static resource api/v1/distribution\.?$') { $classification = '정적 자원 없음이 오류로 처리됨' }
        } catch { }
        throw "desktop distribution 부재 응답은404여야 합니다: HTTP $($distribution.Status), $classification (클래스 포함 여부는 artifact 검사로 별도 판정)"
    }
    # Plugin management and execution are central only; private H2 is not a plugin host.
    $source = "({id:'central-only',label:'central',inputs:[],outputs:[{key:'host'}],apply(){return {host:'server'}}})"
    $created = Request $server '/api/v1/plugins/scripts' '' 'POST' @{ source = $source }
    Require ($created.Status -eq 201) '중앙 플러그인 저장 실패'
    $plugin = $created.Body | ConvertFrom-Json
    Require ((Request $server "/api/v1/plugins/scripts/$($plugin.id)/submit" '' 'POST').Status -eq 200) '중앙 플러그인 제출 실패'
    Require ((Request $server "/api/v1/plugins/scripts/$($plugin.id)/approve" '' 'POST').Status -eq 200) '중앙 플러그인 승인 실패'
    $preview = Request $server '/api/v1/transforms/central-only/preview' '' 'POST' @{ inputs = @{}; config = @{} }
    Require ($preview.Status -eq 200 -and ($preview.Body | ConvertFrom-Json).outputs.host -eq 'server') '중앙 승인본 실행 실패'
    foreach ($path in @('/api/v1/plugins', '/api/v1/plugins/api', '/api/v1/plugins/scripts', "/api/v1/plugins/scripts/$($plugin.id)", '/api/v1/transforms', '/api/v1/codecs')) {
        Require ((Request $desktop $path $agent.token).Status -eq 403) '개인 플러그인 API가 허용됐습니다.'
    }
    Require ((Request $desktop '/api/v1/plugins/scripts' $agent.token 'POST' @{ source = $source }).Status -eq 403) '개인 플러그인 저장이 허용됐습니다.'
    Require ((Request $desktop '/api/v1/transforms/central-only/preview' $agent.token 'POST' @{ inputs = @{} }).Status -eq 403) '개인 플러그인 미리보기가 허용됐습니다.'
    Require ((Request $desktop '/api/v1/secrets' $agent.token).Status -eq 200) '직접 입력한 개인 시크릿 API가 차단됐습니다.'
    $graph = @{ nodes = @(@{id='start';type='start'}, @{id='plugin';type='transform';transformId='central-only';executionAgent='local';agentWorkspaceId='obsolete';agentEnvironment='obsolete'}, @{id='end';type='end'}); edges = @(@{from='start';to='plugin'}, @{from='plugin';to='end'}) }
    foreach ($app in @($server, $desktop)) {
        $token = if ($app.Role -eq 'desktop') { $agent.token } else { '' }
        $flowResponse = Request $app '/api/v1/flows' $token 'POST' @{name='central-plugin-policy'}
        Require ($flowResponse.Status -eq 201) '격리 흐름 생성 실패'
        $flow = $flowResponse.Body | ConvertFrom-Json
        Require ((Request $app "/api/v1/flows/$($flow.id)/versions" $token 'POST' @{graph=$graph}).Status -eq 201) '격리 그래프 저장 실패'
        $started = Request $app "/api/v1/flows/$($flow.id)/runs" $token 'POST' @{}
        if ($app.Role -eq 'desktop') {
            Require ($started.Status -eq 400 -and $started.Body -match '공용·팀') '개인 흐름의 중앙 플러그인 우회 실행이 허용됐습니다.'
        } else {
            Require ($started.Status -eq 200) '중앙 변환 실행 시작 실패'
            $execution = $started.Body | ConvertFrom-Json
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            while ($execution.status -in @('RUNNING','WAITING') -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 200
                $execution = (Request $app "/api/v1/executions/$($execution.id)").Body | ConvertFrom-Json
            }
            $node = @($execution.nodes | Where-Object nodeId -eq 'plugin')[0]
            Require ($execution.status -eq 'SUCCEEDED' -and $node.executionAgent -eq 'server' -and $node.output.host -eq 'server') '변환에 기존 PC/공간/환경 설정이 적용됐습니다.'
        }
    }
    $createdMock = Request $desktop '/api/v1/mock-servers' $agent.token 'POST' @{name='personal-plugin-policy';slug='personal-plugin-policy';type='HTTP'}
    Require ($createdMock.Status -eq 201) '개인 Mock 생성 실패'
    $mockId = ($createdMock.Body | ConvertFrom-Json).id
    $codec = @{response=@(@{id='central-only'})}
    $rejectedMock = Request $desktop "/api/v1/mock-servers/$mockId/spec" $agent.token 'PUT' @{spec=@{routes=@();codec=$codec}}
    Require ($rejectedMock.Status -eq 400 -and $rejectedMock.Body -match '개인 Mock') '개인 Mock 플러그인 저장이 허용됐습니다.'
    Require ((Request $desktop "/api/v1/mock-servers/$mockId/codec-try" $agent.token 'POST' @{codec=$codec;side='response';message='test'}).Status -eq 403) '개인 Mock 코덱 시험이 허용됐습니다.'
    $badServer = Start-App 'server' 'reject-server-desktop' @('--spring.profiles.active=local,desktop')
    Require-Rejection $badServer 'desktop'
    $badDesktop = Start-App 'desktop' 'reject-desktop-bind' @('--server.address=0.0.0.0')
    Require-Rejection $badDesktop '127\.0\.0\.1|루프백|loopback'
    Write-Output 'PASS: server 작업 화면 없음·desktop SPA·중앙 플러그인 승인/실행·개인 플러그인 API 차단·개인 접근 보호·로그인/배포 API·잘못된 프로파일/bind 거부'
    Write-Output "격리 로그: $work (토큰은 출력하지 않음; headless 속성 자체 검사는 별도)"
} finally {
    $client.Dispose()
    foreach ($proc in $processes) {
        $proc.Refresh()
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force; [void]$proc.WaitForExit(10000) }
        $proc.Dispose()
    }
}
