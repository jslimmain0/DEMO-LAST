<#
.SYNOPSIS
  FlowLink 개발 스택을 종료한다 (Windows / PowerShell).
.DESCRIPTION
  dev-all.ps1 이 띄운 서비스들을 정리한다:
    - backend 는 backend\scripts\stop.ps1 로 깔끔히 종료
    - vite 는 포트(5173) 점유 프로세스를 종료
  포트 기반 정리라 창을 수동으로 닫지 않아도 되고, 옛 프로세스가 포트를 선점한 경우도 함께 회수한다.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-stop.ps1
#>
[CmdletBinding()]
param()

$Root = Split-Path -Parent $PSScriptRoot

# 1) backend — 전용 종료 스크립트(깔끔한 shutdown + PID 정리)
$stop = Join-Path $Root 'backend\scripts\stop.ps1'
if (Test-Path $stop) {
  try {
    powershell -ExecutionPolicy Bypass -File $stop -KeepDb
  } catch {
    Write-Host "backend stop.ps1 실행 중 경고: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# 2) vite — 포트 점유 프로세스 종료 (backend 18080 도 안전망으로 포함)
$ports = 18080, 5173
foreach ($port in $ports) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in $conns) {
      $procId = $conn.OwningProcess
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) {
        Write-Host "포트 $port 정리: $($proc.ProcessName) (PID $procId)" -ForegroundColor Cyan
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {
    # Get-NetTCPConnection 미지원 환경 — 무시
  }
}

Write-Host "FlowLink 개발 스택을 종료했습니다." -ForegroundColor Green
