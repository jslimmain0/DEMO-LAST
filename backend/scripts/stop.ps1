<#
.SYNOPSIS
  Flowlink 백엔드 종료 스크립트 (Windows / PowerShell).
.DESCRIPTION
  .run/flowlink.pid 의 앱 프로세스를 종료하고, 기본적으로 Postgres(docker compose) 컨테이너도 정지한다.
  데이터 볼륨은 보존한다(-RemoveDb 지정 시에만 제거).
.PARAMETER KeepDb     앱만 종료하고 Postgres 컨테이너는 그대로 둔다.
.PARAMETER RemoveDb   Postgres 컨테이너와 볼륨까지 제거(docker compose down -v).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
  powershell -ExecutionPolicy Bypass -File scripts\stop.ps1 -KeepDb
#>
[CmdletBinding()]
param(
  [switch]$KeepDb,
  [switch]$RemoveDb
)
$ErrorActionPreference = 'Stop'

$Backend = Split-Path -Parent $PSScriptRoot
$RunDir  = Join-Path $Backend '.run'
$PidFile = Join-Path $RunDir 'flowlink.pid'

# 1) 앱 종료
if (Test-Path $PidFile) {
  $appPid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  $proc = if ($appPid) { Get-Process -Id $appPid -ErrorAction SilentlyContinue } else { $null }
  if ($proc) {
    Write-Host "앱 종료 (PID $appPid)..." -ForegroundColor Cyan
    Stop-Process -Id $appPid -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue
    }
    Write-Host "앱이 종료되었습니다." -ForegroundColor Green
  } else {
    Write-Host "실행 중인 앱이 없습니다 (PID $appPid)." -ForegroundColor Yellow
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
} else {
  Write-Host "PID 파일이 없습니다 — 백그라운드로 실행된 앱이 없습니다." -ForegroundColor Yellow
}

# 2) Postgres (docker)
if (-not $KeepDb) {
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    Push-Location $Backend
    try {
      if ($RemoveDb) {
        Write-Host "Postgres 컨테이너+볼륨 제거 (docker compose down -v)..." -ForegroundColor Cyan
        docker compose down -v
      } else {
        Write-Host "Postgres 컨테이너 정지 (docker compose stop)..." -ForegroundColor Cyan
        docker compose stop
      }
    } finally { Pop-Location }
  }
} else {
  Write-Host "Postgres 는 그대로 둡니다 (-KeepDb)." -ForegroundColor Yellow
}

