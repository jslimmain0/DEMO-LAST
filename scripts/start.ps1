# FlowLink main app start (Windows). Runs the single jar (UI+API) in background and waits for health.
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1          # run existing jar (default profile local = H2 file)
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Build   # rebuild frontend+backend then run
# Inject DB/auth via env: $env:SPRING_PROFILES_ACTIVE (dev = Oracle), $env:FLOWLINK_DB_URL, ... Port: $env:FLOWLINK_PORT (default 18080).
# Path prefix (context path): $env:FLOWLINK_CONTEXT_PATH='/flowlink' -> app served at http://host:port/flowlink/ (leading slash, no trailing slash).
# MCP HTTP server (for agents, needs Node 20+): started next to the jar as `node mcp\src\index.js --http` at http://host:FLOWLINK_MCP_PORT/mcp (default 18090).
#   $env:FLOWLINK_MCP_PORT='0' disables it; without node it is skipped with a warning. The Settings dialog shows the URL; login happens in the browser (GitHub OAuth) on first connect - no token config.
# (ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8 non-ASCII in .ps1 files.)
param([switch]$Build)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $Root '.run'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$PidFile = Join-Path $RunDir 'flowlink.pid'
$Log = Join-Path $RunDir 'flowlink.log'
$McpPidFile = Join-Path $RunDir 'flowlink-mcp.pid'
$McpLog = Join-Path $RunDir 'flowlink-mcp.log'
$McpPort = if ($env:FLOWLINK_MCP_PORT) { $env:FLOWLINK_MCP_PORT } else { '18090' }
$Jar = Join-Path $Root 'backend\build\libs\flowlink.jar'
$Port = if ($env:FLOWLINK_PORT) { $env:FLOWLINK_PORT } else { '18080' }
$Ctx = if ($env:FLOWLINK_CONTEXT_PATH) { '/' + $env:FLOWLINK_CONTEXT_PATH.Trim('/') } else { '' }
if ($Ctx -eq '/') { $Ctx = '' }
$env:FLOWLINK_CONTEXT_PATH = $Ctx   # normalized form for Spring (leading slash, no trailing slash)

# Resolve JDK 21: PATH -> JAVA_HOME -> ~\.jdks\*21*
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $env:PATH = "$($env:JAVA_HOME)\bin;$($env:PATH)"
  } else {
    $cand = Get-ChildItem "$HOME\.jdks" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '21' } | Select-Object -First 1
    if ($cand) { $env:JAVA_HOME = $cand.FullName; $env:PATH = "$($cand.FullName)\bin;$($env:PATH)"; Write-Host "JDK detected: $($cand.FullName)" }
  }
}
if (-not (Get-Command java -ErrorAction SilentlyContinue)) { Write-Host "ERROR: java (JDK 21) not found. Set JAVA_HOME."; exit 1 }

# Already running?
if (Test-Path $PidFile) {
  $existing = Get-Content $PidFile
  if (Get-Process -Id $existing -ErrorAction SilentlyContinue) { Write-Host "Already running (PID $existing). Run scripts\stop.ps1 first."; exit 0 }
}

# Build (on -Build or missing jar)
if ($Build -or -not (Test-Path $Jar)) {
  Write-Host "> Building frontend..."
  Push-Location (Join-Path $Root 'frontend')
  if (-not (Test-Path 'node_modules')) { npm ci }
  npm run build
  Pop-Location
  Write-Host "> Building backend bootJar..."
  Push-Location (Join-Path $Root 'backend')
  & (Join-Path (Get-Location) 'gradlew.bat') bootJar -q
  Pop-Location
}
if (-not (Test-Path $Jar)) { Write-Host "ERROR: jar missing: $Jar - run start.ps1 -Build"; exit 1 }
# MCP HTTP server deps (pure JS, no build - node_modules only)
$hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
if ($McpPort -ne '0' -and $hasNode -and -not (Test-Path (Join-Path $Root 'mcp\node_modules'))) {
  Write-Host "> Installing MCP deps..."
  Push-Location (Join-Path $Root 'mcp'); npm ci --no-audit --no-fund; Pop-Location
}

if (-not $env:SPRING_PROFILES_ACTIVE) { $env:SPRING_PROFILES_ACTIVE = 'local' } # default local (H2 file)
$env:FLOWLINK_PORT = $Port
# The jar gets FLOWLINK_MCP_PORT too so /auth/config can tell the Settings dialog where MCP is ('0' -> unset).
$env:FLOWLINK_MCP_PORT = if ($McpPort -eq '0') { '' } else { $McpPort }

# JVM args. On Windows, trust the Windows certificate store so outbound TLS (AI/Copilot, etc.) works even
# behind a corporate TLS-intercepting proxy/VPN (whose CA is in the Windows store but not Java cacerts).
# Opt out with FLOWLINK_WINROOT=0. Extra opts via FLOWLINK_JAVA_OPTS (space-separated).
$jvmArgs = @()
if ($env:FLOWLINK_WINROOT -ne '0') { $jvmArgs += '-Djavax.net.ssl.trustStoreType=WINDOWS-ROOT' }
if ($env:FLOWLINK_JAVA_OPTS) { $jvmArgs += ($env:FLOWLINK_JAVA_OPTS -split ' ' | Where-Object { $_ }) }
$jvmArgs += @('-jar', $Jar)

Write-Host "> Starting FlowLink (profile=$($env:SPRING_PROFILES_ACTIVE), port=$Port)..."
$p = Start-Process -FilePath 'java' -ArgumentList $jvmArgs -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -WindowStyle Hidden -PassThru
$p.Id | Out-File -Encoding ascii $PidFile

# MCP HTTP server - started before the jar health wait (it only connects to REST per tool call).
if ($McpPort -ne '0') {
  if ($hasNode) {
    $mcpRunning = $false
    if (Test-Path $McpPidFile) { $mcpRunning = [bool](Get-Process -Id (Get-Content $McpPidFile) -ErrorAction SilentlyContinue) }
    if ($mcpRunning) { Write-Host "MCP server already running (PID $(Get-Content $McpPidFile))" }
    else {
      $env:FLOWLINK_URL = "http://localhost:$Port$Ctx"
      $env:FLOWLINK_MCP_PORT = $McpPort
      $m = Start-Process -FilePath 'node' -ArgumentList @((Join-Path $Root 'mcp\src\index.js'), '--http') -RedirectStandardOutput $McpLog -RedirectStandardError "$McpLog.err" -WindowStyle Hidden -PassThru
      $m.Id | Out-File -Encoding ascii $McpPidFile
      Write-Host "> MCP HTTP server at http://localhost:$McpPort/mcp (PID $($m.Id), log $McpLog)"
    }
  } else {
    Write-Host "WARN: node not found - MCP HTTP server not started (install Node 20+ or set FLOWLINK_MCP_PORT=0)."
  }
}

for ($i = 0; $i -lt 60; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing "http://localhost:$Port$Ctx/api/v1/auth/config" -TimeoutSec 2).StatusCode -eq 200) {
    Write-Host "OK: up at http://localhost:$Port$Ctx (PID $($p.Id), log $Log)"; exit 0 } } catch {}
  Start-Sleep -Seconds 1
}
Write-Host "WARN: health not UP within 60s. Check log: $Log"; exit 1
