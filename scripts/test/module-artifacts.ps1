param(
    [string]$ServerJar = (Join-Path $PSScriptRoot '../../backend/flow-server/build/libs/flowlink-server.jar'),
    [string]$DesktopJar = (Join-Path $PSScriptRoot '../../backend/flow-desktop/build/libs/flowlink-desktop.jar'),
    [string]$AgentJar = (Join-Path $PSScriptRoot '../../backend/flow-agent/build/libs/flowlink-agent.jar'),
    [string]$McpJar = (Join-Path $PSScriptRoot '../../backend/flow-mcp/build/libs/flowlink-mcp.jar'),
    [string]$CoreJar = (Join-Path $PSScriptRoot '../../backend/flow-core/build/libs/flowlink-core.jar')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Read-Entry($Entry) {
    $reader = [System.IO.StreamReader]::new($Entry.Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Inspect-Agent([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) "agent JAR이 없습니다: $Path"
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        Require (@($names | Where-Object { $_ -like 'BOOT-INF/*' }).Count -eq 0) 'agent는 plain JAR여야 합니다.'
        Require (@($names | Where-Object { $_ -match '^com/flowlink/(core/repository|workspace|secret|vault|distribution|presence|desktop|server|mcp)/.+\.class$' }).Count -eq 0) 'agent에 DB·관리·호스트 클래스가 포함됐습니다.'
        Require (@($names | Where-Object { $_ -match '^(jakarta/persistence|org/hibernate|oracle/jdbc|org/h2)/' }).Count -eq 0) 'agent에 DB 구현 클래스가 포함됐습니다.'
        Require (@($names | Where-Object { $_ -match '^com/flowlink/.+\.class$' }).Count -gt 0) 'agent 구현 클래스가 없습니다.'
        foreach ($name in @('execution/engine/HttpNodeExecutor', 'execution/engine/TcpNodeExecutor', 'mock/MockRuntime', 'agent/AgentNodeExecutor')) {
            Require ($names -contains "com/flowlink/$name.class") "agent 실행 구현이 없습니다: $name"
        }
        foreach ($entry in $archive.Entries) {
            if (-not $entry.FullName.EndsWith('.class')) { continue }
            $constants = Read-Entry $entry
            Require ($constants -notmatch 'jakarta/persistence/|org/hibernate/|org/springframework/data/jpa/|com/flowlink/core/repository/|com/flowlink/(workspace/WorkspaceService|secret/(SecretService|Vault))') "agent 클래스에 DB·관리 의존성이 있습니다: $($entry.FullName)"
        }
    } finally { $archive.Dispose() }
}
function Inspect-Core([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) "core JAR이 없습니다: $Path"
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        Require (@($names | Where-Object { $_ -like 'BOOT-INF/*' }).Count -eq 0) 'core는 plain JAR여야 합니다.'
        Require (@($names | Where-Object { $_ -match '^com/flowlink/(server|distribution|presence|desktop|mcp)/.+\.class$' }).Count -eq 0) 'core에 중앙 서버·Windows·MCP 구현이 포함됐습니다.'
        Require (@($names | Where-Object { $_ -match '^com/flowlink/security/(AppJwt|AuthConfig|GithubAuthService|GithubLoginController|McpToken).+\.class$|^com/flowlink/security/(AppJwt|AuthConfig|GithubAuthService|GithubLoginController|McpToken)\.class$' }).Count -eq 0) 'core에 중앙 로그인·토큰 발급 구현이 포함됐습니다.'
        Require (@($names | Where-Object { $_ -match '^(application\.yml|application-(local|desktop|dev|agent-lab|oracle)\.yml|static/|db/)' }).Count -eq 0) 'core에 호스트 DB/화면/SQL 설정이 포함됐습니다.'
        foreach ($name in @('FlowlinkApplication', 'core/domain/Flow', 'execution/ExecutionService', 'workspace/WorkspaceService', 'security/SecurityConfig')) {
            Require ($names -contains "com/flowlink/$name.class") "core 공통 구현이 없습니다: $name"
        }
        Require ($names -contains 'application-core.yml') 'core 공통 ORM/웹 설정이 없습니다.'
    } finally { $archive.Dispose() }
}
function Inspect-Mcp([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) "flow-mcp JAR이 없습니다: $Path"
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    try {
        Require ($null -ne $archive.GetEntry('com/flowlink/mcp/McpConfiguration.class')) '중앙 MCP 구성 클래스가 없습니다.'
        Require (@($archive.Entries | Where-Object { $_.FullName -like 'BOOT-INF/*' }).Count -eq 0) 'flow-mcp는 plain 라이브러리 JAR여야 합니다.'
    } finally { $archive.Dispose() }
}
function Inspect-Jar([string]$Path, [string]$Role, [string]$MainClass) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) "$Role JAR이 없습니다: $Path"
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
    $classes = [System.Collections.Generic.HashSet[string]]::new()
    $versions = [System.Collections.Generic.HashSet[string]]::new()
    $hasH2 = $false
    $hasOracle = $false
    try {
        $manifest = $archive.GetEntry('META-INF/MANIFEST.MF')
        Require ($null -ne $manifest) "$Role manifest가 없습니다."
        $manifestText = (Read-Entry $manifest) -replace "\r?\n ", ''
        Require ($manifestText -match "(?m)^Start-Class: $([regex]::Escape($MainClass))\r?$") "$Role Start-Class가 다릅니다."
        Require ($null -ne $archive.GetEntry('BOOT-INF/lib/flowlink-core.jar')) "$Role 공통 core 라이브러리가 없습니다."
        $hasFrontend = $null -ne $archive.GetEntry('BOOT-INF/classes/static/index.html')
        Require ($hasFrontend -eq ($Role -eq 'desktop')) "$Role 작업 프론트는 desktop에만 포함해야 합니다."
        foreach ($asset in @('PretendardVariable.woff2', 'OFL.txt')) {
            $fontAsset = $archive.GetEntry("BOOT-INF/classes/static/fonts/$asset")
            Require ($null -ne $fontAsset -and $fontAsset.Length -gt 0) "$Role 오프라인 글꼴·라이선스가 없습니다: $asset"
        }
        if ($Role -eq 'server') {
            Require (@($archive.Entries | Where-Object {
                $_.FullName -like 'BOOT-INF/classes/static/*' -and
                -not $_.FullName.EndsWith('/') -and
                $_.FullName -notin @('BOOT-INF/classes/static/download.html', 'BOOT-INF/classes/static/fonts/PretendardVariable.woff2', 'BOOT-INF/classes/static/fonts/OFL.txt')
            }).Count -eq 0) 'server에는 소개 페이지와 글꼴 외의 작업 화면 자산을 포함하면 안 됩니다.'
        }
        if ($Role -eq 'desktop') {
            Require (@($archive.Entries | Where-Object { $_.FullName -match '^BOOT-INF/lib/flowlink-(server|mcp).*\.jar$' }).Count -eq 0) 'desktop은 중앙 server/MCP 모듈에 의존하면 안 됩니다.'
        }
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('.class')) { [void]$classes.Add(($entry.FullName -replace '^BOOT-INF/classes/', '')) }
            if ($entry.FullName.EndsWith('flowlink-release.properties')) {
                $release = Read-Entry $entry
                Require ($release -match '(?m)^version\s*=\s*(\d+\.\d+\.\d+)\s*$') "$Role 릴리스 버전 형식이 잘못됐습니다."
                [void]$versions.Add($Matches[1])
            }
            if ($entry.FullName -notmatch '^BOOT-INF/lib/.+\.jar$') { continue }
            $stream = [System.IO.MemoryStream]::new()
            $input = $entry.Open()
            try { $input.CopyTo($stream) } finally { $input.Dispose() }
            $stream.Position = 0
            $nested = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read)
            try {
                foreach ($item in $nested.Entries) {
                    if ($item.FullName.EndsWith('.class')) { [void]$classes.Add($item.FullName) }
                    if ($item.FullName -eq 'org/h2/Driver.class') { $hasH2 = $true }
                    if ($item.FullName -eq 'oracle/jdbc/OracleDriver.class') { $hasOracle = $true }
                    if ($item.FullName -eq 'flowlink-release.properties') {
                        $release = Read-Entry $item
                        Require ($release -match '(?m)^version\s*=\s*(\d+\.\d+\.\d+)\s*$') "$Role 내부 모듈 버전이 잘못됐습니다."
                        [void]$versions.Add($Matches[1])
                    }
                }
            } finally { $nested.Dispose(); $stream.Dispose() }
        }
        $nativeClasses = @('DesktopTray', 'DesktopLaunch', 'DesktopDispatcher', 'DesktopUpdateService', 'SpaStaticConfig')
        foreach ($name in $nativeClasses) {
            $present = $classes.Contains("com/flowlink/desktop/$name.class") -or $classes.Contains("com/flowlink/desktop/${name}Kt.class")
            Require ($present -eq ($Role -eq 'desktop')) "$Role 에 $name 역할 경계가 잘못됐습니다."
        }
        Require ($classes.Contains('com/flowlink/distribution/DistributionController.class') -eq ($Role -eq 'server')) "$Role DistributionController 경계가 잘못됐습니다."
        Require ($classes.Contains('com/flowlink/mcp/McpConfiguration.class') -eq ($Role -eq 'server')) "$Role 중앙 MCP 구성 경계가 잘못됐습니다."
        Require ($classes.Contains('io/modelcontextprotocol/server/McpServer.class') -eq ($Role -eq 'server')) "$Role MCP SDK 경계가 잘못됐습니다."
        foreach ($name in @('PresenceConfig', 'PresenceHandler')) {
            Require ($classes.Contains("com/flowlink/presence/$name.class") -eq ($Role -eq 'server')) "$Role 중앙 협업 $name 경계가 잘못됐습니다."
        }
        foreach ($name in @('AppJwt', 'AuthConfig', 'GithubAuthService', 'GithubLoginController')) {
            Require ($classes.Contains("com/flowlink/security/$name.class") -eq ($Role -eq 'server')) "$Role 중앙 로그인 발급 $name 경계가 잘못됐습니다."
        }
        if ($Role -eq 'server') {
            Require (@($classes | Where-Object { $_ -like 'com/flowlink/desktop/*' }).Count -eq 0) 'server에 Windows 전용 클래스가 포함됐습니다.'
        } else {
            Require (@($classes | Where-Object { $_ -like 'com/flowlink/server/*' -or $_ -like 'com/flowlink/distribution/*' -or $_ -like 'com/flowlink/presence/*' }).Count -eq 0) 'desktop에 서버 진입점·배포·중앙 협업 클래스가 포함됐습니다.'
            Require (@($classes | Where-Object { $_ -like 'com/flowlink/mcp/*' -or $_ -like 'io/modelcontextprotocol/*' }).Count -eq 0) 'desktop에 중앙 MCP 또는 SDK 클래스가 포함됐습니다.'
        }
        Require ($hasOracle -eq ($Role -eq 'server')) "$Role Oracle 드라이버 경계가 잘못됐습니다."
        if ($Role -eq 'desktop') { Require $hasH2 'desktop H2 드라이버가 없습니다.' }
        Require ($versions.Count -eq 1) "$Role 릴리스 버전이 없거나 내부 버전이 다릅니다."
        return @($versions)[0]
    } finally { $archive.Dispose() }
}
Inspect-Agent $AgentJar
Inspect-Core $CoreJar
Inspect-Mcp $McpJar
$serverVersion = Inspect-Jar $ServerJar 'server' 'com.flowlink.server.ServerApplicationKt'
$desktopVersion = Inspect-Jar $DesktopJar 'desktop' 'com.flowlink.desktop.DesktopApplicationKt'
Require ($serverVersion -eq $desktopVersion) '서버·Windows 앱 릴리스 버전이 다릅니다.'
Write-Output "PASS: agent/core/MCP plain JAR·DB/관리/호스트 분리·server/desktop 역할·SDK·진입점·드라이버·릴리스 $serverVersion"
