# FlowLink main app stop (Windows). ASCII-only (PowerShell 5.1 encoding safety).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $Root '.run\flowlink.pid'

if (-not (Test-Path $PidFile)) { Write-Host "No PID file - not running."; exit 0 }
$thePid = Get-Content $PidFile
$proc = Get-Process -Id $thePid -ErrorAction SilentlyContinue
if (-not $proc) { Write-Host "Process (PID $thePid) not found - clearing PID file."; Remove-Item $PidFile -Force; exit 0 }

Write-Host "> Stopping (PID $thePid)..."
try { Stop-Process -Id $thePid -Force -ErrorAction Stop } catch {}
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "OK: stopped."
