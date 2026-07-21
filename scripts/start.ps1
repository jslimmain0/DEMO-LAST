# FlowLink main app start (Windows). Runs the single jar (UI+API) in background and waits for health.
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1          # run existing jar (default H2)
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Build   # rebuild frontend+backend then run
# Inject DB/auth via env: $env:SPRING_PROFILES_ACTIVE, $env:FLOWLINK_DB_URL, ... Port: $env:FLOWLINK_PORT (default 18080).
# (ASCII-only on purpose: Windows PowerShell 5.1 mis-parses UTF-8 non-ASCII in .ps1 files.)
param([switch]$Build)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$RunDir = Join-Path $Root '.run'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$PidFile = Join-Path $RunDir 'flowlink.pid'
$Log = Join-Path $RunDir 'flowlink.log'
$Jar = Join-Path $Root 'backend\build\libs\flowlink.jar'
$Port = if ($env:FLOWLINK_PORT) { $env:FLOWLINK_PORT } else { '18080' }

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

if (-not $env:SPRING_PROFILES_ACTIVE) { $env:SPRING_PROFILES_ACTIVE = 'h2' } # default H2 (local)
$env:FLOWLINK_PORT = $Port

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

for ($i = 0; $i -lt 60; $i++) {
  try { if ((Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/actuator/health" -TimeoutSec 2).StatusCode -eq 200) {
    Write-Host "OK: up at http://localhost:$Port (PID $($p.Id), log $Log)"; exit 0 } } catch {}
  Start-Sleep -Seconds 1
}
Write-Host "WARN: health not UP within 60s. Check log: $Log"; exit 1
