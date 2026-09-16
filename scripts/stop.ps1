# FlowLink main app + MCP HTTP server stop (Windows). ASCII-only (PowerShell 5.1 encoding safety).
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

function Stop-One([string]$Name, [string]$PidFile) {
  if (-not (Test-Path $PidFile)) { Write-Host "${Name}: no PID file - not running."; return }
  $thePid = Get-Content $PidFile
  $proc = Get-Process -Id $thePid -ErrorAction SilentlyContinue
  if (-not $proc) { Write-Host "${Name}: process (PID $thePid) not found - clearing PID file."; Remove-Item $PidFile -Force; return }
  Write-Host "> Stopping $Name (PID $thePid)..."
  try { Stop-Process -Id $thePid -Force -ErrorAction Stop } catch {}
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-One 'MCP server' (Join-Path $Root '.run\flowlink-mcp.pid')
Stop-One 'FlowLink' (Join-Path $Root '.run\flowlink.pid')
Write-Host "OK: stopped."
