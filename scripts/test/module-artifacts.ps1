param(
    [string]$ServerJar = (Join-Path $PSScriptRoot '../../backend/server-app/build/libs/flowlink-server.jar'),
    [string]$DesktopJar = (Join-Path $PSScriptRoot '../../backend/desktop-app/build/libs/flowlink-desktop.jar')
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
                        Require ($release -match '(?m)^version\s*=\s*(\d+\.\d+\.\d+)\s*$') "$Role 내부 runtime 버전이 잘못됐습니다."
                        [void]$versions.Add($Matches[1])
                    }
                }
            } finally { $nested.Dispose(); $stream.Dispose() }
        }
        $nativeClasses = @('DesktopTray', 'DesktopLaunch', 'DesktopDispatcher', 'DesktopUpdateService')
        foreach ($name in $nativeClasses) {
            $present = $classes.Contains("com/flowlink/desktop/$name.class") -or $classes.Contains("com/flowlink/desktop/${name}Kt.class")
            Require ($present -eq ($Role -eq 'desktop')) "$Role 에 $name 역할 경계가 잘못됐습니다."
        }
        Require ($classes.Contains('com/flowlink/distribution/DistributionController.class') -eq ($Role -eq 'server')) "$Role DistributionController 경계가 잘못됐습니다."
        Require ($hasOracle -eq ($Role -eq 'server')) "$Role Oracle 드라이버 경계가 잘못됐습니다."
        if ($Role -eq 'desktop') { Require $hasH2 'desktop H2 드라이버가 없습니다.' }
        Require ($versions.Count -eq 1) "$Role 릴리스 버전이 없거나 내부 버전이 다릅니다."
        return @($versions)[0]
    } finally { $archive.Dispose() }
}
$serverVersion = Inspect-Jar $ServerJar 'server' 'com.flowlink.server.ServerApplicationKt'
$desktopVersion = Inspect-Jar $DesktopJar 'desktop' 'com.flowlink.desktop.DesktopApplicationKt'
Require ($serverVersion -eq $desktopVersion) '서버·Windows 앱 릴리스 버전이 다릅니다.'
Write-Output "PASS: server/desktop 클래스·진입점·DB 드라이버·내부 runtime·릴리스 $serverVersion"
