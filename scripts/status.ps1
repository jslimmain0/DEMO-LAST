# FlowLink main app status (Windows). PID alive + health. ASCII-only (PowerShell 5.1 encoding safety).
$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root '.run\flowlink.pid'
$Port = if ($env:FLOWLINK_PORT) { $env:FLOWLINK_PORT } else { '18080' }
$Ctx = if ($env:FLOWLINK_CONTEXT_PATH) { '/' + $env:FLOWLINK_CONTEXT_PATH.Trim('/') } else { '' }
if ($Ctx -eq '/') { $Ctx = '' }

$running = $false
if (Test-Path $PidFile) {
  $thePid = Get-Content $PidFile
  if (Get-Process -Id $thePid -ErrorAction SilentlyContinue) { $running = $true; Write-Host "Process: running (PID $thePid)" }
}
if (-not $running) { Write-Host "Process: stopped" }

try {
  if ((Invoke-WebRequest -UseBasicParsing "http://localhost:$Port$Ctx/actuator/health" -TimeoutSec 2).StatusCode -eq 200) {
    Write-Host "Health : UP (http://localhost:$Port$Ctx)"; exit 0
  }
} catch {}
Write-Host "Health : DOWN (http://localhost:$Port$Ctx)"
if ($running) { Write-Host "(process alive but no health response - starting up or errored. Log: $Root\.run\flowlink.log)" }
exit 1
