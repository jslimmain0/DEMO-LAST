<#
.SYNOPSIS
  FlowLink 전체 개발 스택을 한 번에 기동한다 (Windows / PowerShell).
.DESCRIPTION
  개발 서비스를 함께 올린다 — 각 서비스는 별도 콘솔 창으로 띄워 로그와 포트를 그대로 노출한다
  (런처가 토폴로지를 가리지 않도록). 종료는 scripts\dev-stop.ps1.
    backend  :18080  API + 실행 엔진 (H2 파일 DB — Postgres/Docker 불필요) · 내장 Mock 서빙(/mock/{slug})
                     · wait(콜백 대기) 콜백 수신(/relay/{execId}/cb/{nodeId}) 도 백엔드 통합
    vite     :5173   프론트 개발 서버 (/api → :18080 프록시)
  가짜 대상 시스템(demos)은 별도 프로세스 없이 백엔드 내장 Mock 으로 서빙한다 — seed-mock.mjs 가
  백엔드에 slug `demo` mock 을 심는다(1회 실행 창). 기존 수동 절차는 demos/README 참고.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\dev-all.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "  FlowLink 개발 스택 기동" -ForegroundColor Cyan
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "   backend  http://localhost:18080   API + 실행 엔진 (H2) · 내장 Mock · wait 콜백" -ForegroundColor Gray
Write-Host "   vite     http://localhost:5173    프론트 개발 서버"           -ForegroundColor Gray
Write-Host "   seed     demos/seed-mock.mjs      백엔드에 mock 대상 심기(1회)" -ForegroundColor Gray
Write-Host "  ------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "  종료: powershell -ExecutionPolicy Bypass -File scripts\dev-stop.ps1" -ForegroundColor DarkGray
Write-Host ""

# 각 서비스를 별도 창(제목 포함)으로 기동. -NoExit 로 창 유지(로그 확인).
function Start-Service([string]$Title, [string]$Command) {
  Start-Process powershell -ArgumentList @(
    '-NoExit', '-ExecutionPolicy', 'Bypass',
    '-Command', "`$Host.UI.RawUI.WindowTitle = '$Title'; $Command"
  ) -WindowStyle Normal | Out-Null
  Write-Host "  기동: $Title" -ForegroundColor Green
}

# 1) backend — 기존 start.ps1 -H2 (백그라운드+헬스 대기 내장). 별도 창에서 실행해 로그 노출.
Start-Service 'FlowLink backend (:18080)' "cd '$Root\backend'; powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -H2; Write-Host 'backend start.ps1 완료 — 로그: backend\.run\flowlink.out.log'"

# 2) vite — 최초 실행 시 의존성 설치
Start-Service 'FlowLink frontend (:5173)' "cd '$Root\frontend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"

# 3) seed — 백엔드 내장 Mock 에 데모 대상(slug `demo`) 심기. seed-mock.mjs 가 백엔드 헬스를 자체 대기.
Start-Service 'FlowLink seed-mock (1회)' "cd '$Root'; node demos\seed-mock.mjs; Write-Host '완료 — 이 창은 닫아도 됩니다.'"

Write-Host ""
Write-Host "  서비스 창을 띄웠습니다. 준비되면 http://localhost:5173 열기." -ForegroundColor Cyan
Write-Host ""
