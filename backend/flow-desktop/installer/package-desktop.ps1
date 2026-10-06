# Windows desktop bundle. Java is bundled; MCP runs on the central server.
param(
  [ValidateSet('app-image','exe','msi')][string]$Type = 'app-image',
  [switch]$SkipBuild,
  [string]$JdkPath,
  [string]$WixPath,
  [string]$OutputDir,
  [string]$ServerUrl = $env:FLOWLINK_PUBLIC_URL,
  [string]$ReleaseNotes = 'Windows 앱 업데이트 확인과 설치, 서버 배포 정보 검증 및 앱 화면 개선',
  [ValidateRange(1024,65535)][int]$Port = 18180
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
# The downloaded MSI cannot infer the website it came from. Bind its deployment explicitly.
# Keep this policy aligned with DesktopConnection.validateUrl; loopback HTTP is only an explicit lab choice.
if ([string]::IsNullOrWhiteSpace($ServerUrl)) { throw 'Set -ServerUrl or FLOWLINK_PUBLIC_URL to the public FlowLink server URL. Loopback is never inferred.' }
$ServerUrl = $ServerUrl.Trim().TrimEnd('/')
$ServerUri = $null
if (-not [uri]::TryCreate($ServerUrl, [UriKind]::Absolute, [ref]$ServerUri) -or
    -not [uri]::IsWellFormedUriString($ServerUrl, [UriKind]::Absolute) -or
    [string]::IsNullOrWhiteSpace($ServerUri.Host) -or $ServerUri.UserInfo -or $ServerUri.Query -or $ServerUri.Fragment -or
    $ServerUri.Port -lt 1 -or $ServerUri.Port -gt 65535 -or
    ($ServerUri.Scheme -ne 'https' -and -not ($ServerUri.Scheme -eq 'http' -and $ServerUri.Host -in @('127.0.0.1','localhost','::1','[::1]')))) {
  throw 'ServerUrl must be HTTPS, or explicit loopback HTTP for local tests, without credentials, query, or fragment.'
}
# .NET accepts Unicode/underscore DNS names and short numeric IP forms that Java URI rejects.
# Validate the original host so a package cannot pass here and fail when the native app starts.
$Authority = [regex]::Match($ServerUrl, '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)').Groups[1].Value
$RawHost = if ($Authority.StartsWith('[')) { $Authority.Substring(0, $Authority.IndexOf(']') + 1) } else { $Authority -replace ':[0-9]*$', '' }
$DnsHost = $RawHost.TrimEnd('.')
$DnsLabels = $DnsHost.Split('.')
$IsDnsHost = $DnsHost -match '^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$' -and
  ($DnsLabels.Count -eq 1 -or $DnsLabels[-1] -match '^[a-zA-Z]')
$IpAddress = $null
$IsFullIpv4 = $RawHost -match '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' -and [Net.IPAddress]::TryParse($RawHost, [ref]$IpAddress)
$IsIpv6 = $RawHost.StartsWith('[') -and $ServerUri.HostNameType -eq [UriHostNameType]::IPv6
if (-not ($IsDnsHost -or $IsFullIpv4 -or $IsIpv6)) { throw 'ServerUrl host must be an ASCII DNS name (use punycode for international names) or a full IP address.' }
$ReleaseVersion = [IO.File]::ReadAllText((Join-Path $Root 'VERSION')).Trim()
if ($ReleaseVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'VERSION must contain a three-part release version.' }
if (-not $OutputDir) { $OutputDir = Join-Path $Root 'backend\flow-desktop\build\installer' }
if (-not $JdkPath) { $JdkPath = Split-Path -Parent (Split-Path -Parent (Get-Command java -ErrorAction Stop).Source) }
$Jpackage = Join-Path $JdkPath 'bin\jpackage.exe'
if (-not (Test-Path -LiteralPath $Jpackage)) { throw 'JDK 21 with jpackage is required on the build machine.' }
$Jar = Join-Path $Root 'backend\flow-desktop\build\libs\flowlink-desktop.jar'
if (-not $SkipBuild) {
  Push-Location (Join-Path $Root 'frontend')
  try {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
  } finally { Pop-Location }
  Push-Location (Join-Path $Root 'backend')
  try {
    .\gradlew.bat :flow-desktop:bootJar --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
  } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath $Jar)) { throw 'Build :flow-desktop:bootJar before using -SkipBuild.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$JarZip = [IO.Compression.ZipFile]::OpenRead($Jar)
try {
  $Entry = $JarZip.GetEntry('BOOT-INF/classes/flowlink-release.properties')
  if (-not $Entry) { throw 'JAR release metadata is missing. Rebuild :flow-desktop:bootJar.' }
  $Reader = [IO.StreamReader]::new($Entry.Open())
  try { $JarVersion = $Reader.ReadToEnd().Trim() } finally { $Reader.Dispose() }
  if ($JarVersion -ne "version=$ReleaseVersion") { throw 'JAR version differs from VERSION. Rebuild before packaging.' }
} finally { $JarZip.Dispose() }
$PackageDir = Join-Path $Root ('.run\desktop-package-' + [guid]::NewGuid().ToString('N'))
$InputDir = Join-Path $PackageDir 'input'
$ResourceDir = Join-Path $PackageDir 'resources'
& (Join-Path $PSScriptRoot 'New-DesktopResources.ps1') -OutputDir $ResourceDir -JdkPath $JdkPath -WixPath $WixPath -Installer:($Type -ne 'app-image')
New-Item -ItemType Directory -Path $InputDir -Force | Out-Null
Copy-Item -LiteralPath $Jar -Destination $InputDir
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Apply-DesktopUpdate.ps1') -Destination $InputDir
[System.IO.File]::WriteAllText((Join-Path $InputDir 'server.json'), (@{ serverUrl = $ServerUrl.TrimEnd('/') } | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
$PackageArgs = @('--type',$Type,'--name','FlowLink','--app-version',$ReleaseVersion,'--vendor','FlowLink',
  '--description','FlowLink · 개인 PC와 사내 서버를 연결하는 워크플로 앱',
  '--icon',(Join-Path $ResourceDir 'FlowLink.ico'),'--resource-dir',$ResourceDir,
  '--input',$InputDir,'--dest',$OutputDir,'--main-jar','flowlink-desktop.jar',
  '--main-class','org.springframework.boot.loader.launch.JarLauncher','--add-modules','ALL-MODULE-PATH',
  '--jlink-options','--strip-debug --no-header-files --no-man-pages',
  '--java-options','-Dflowlink.bundle.dir=$APPDIR',
  '--java-options',"-Dflowlink.desktop.port=$Port",
  '--java-options','-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT',
  '--arguments','--spring.profiles.active=local,desktop',
  '--arguments',"--server.port=$Port")
if ($Type -ne 'app-image') {
  $PackageArgs += @('--win-per-user-install','--install-dir','FlowLinkApp','--win-dir-chooser',
    '--win-menu','--win-menu-group','FlowLink','--win-shortcut','--win-shortcut-prompt',
    '--win-upgrade-uuid','b06c875d-2e09-4b64-9e3d-2f52e871d069')
}
if ($WixPath) { $env:Path = (Resolve-Path -LiteralPath $WixPath).Path + ';' + $env:Path }
& $Jpackage @PackageArgs
if ($LASTEXITCODE -ne 0) { throw 'jpackage failed. For exe/msi, install the JDK-compatible WiX build tools.' }
if ($Type -eq 'msi') {
  & (Join-Path $PSScriptRoot 'Publish-DesktopRelease.ps1') -InstallerPath (Join-Path $OutputDir "FlowLink-$ReleaseVersion.msi") -Destination (Join-Path $OutputDir 'distribution') -ReleaseNotes $ReleaseNotes
}
Write-Output "Desktop package: $OutputDir"
