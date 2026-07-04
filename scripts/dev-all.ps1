<#
.SYNOPSIS
  FlowLink 전체 개발 스택을 한 번에 기동한다 (Windows / PowerShell).
.DESCRIPTION
  4개 서비스를 함께 올린다 — 각 서비스는 별도 콘솔 창으로 띄워 로그와 포트를 그대로 노출한다
  (런처가 토폴로지를 가리지 않도록). 종료는 scripts\dev-stop.ps1.
    backend  :18080  API + 실행 엔진 (H2 파일 DB — Postgres/Docker 불필요)
    relay    :8787   wait(콜백 대기) 노드의 콜백 수신 + SSE
    mock     :9090   가짜 대상 시스템(HTTP) · :9091 TCP 전문
    vite     :5173   프론트 개발 서버 (/api → :18080 프록시)
  기존 개별 스크립트/수동 4-터미널 절차(demos/README)는 그대로 유지 — 이 런처는 순수 가산 편의다.
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
Write-Host "   backend  http://localhost:18080   API + 실행 엔진 (H2)"      -ForegroundColor Gray
Write-Host "   relay    http://localhost:8787    wait 콜백 수신 + SSE"       -ForegroundColor Gray
Write-Host "   mock     http://localhost:9090    가짜 시스템 · :9091 TCP"    -ForegroundColor Gray
Write-Host "   vite     http://localhost:5173    프론트 개발 서버"           -ForegroundColor Gray
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

# 2) relay
Start-Service 'FlowLink relay (:8787)' "cd '$Root'; node relay.js"

# 3) mock (HTTP :9090 + TCP :9091)
Start-Service 'FlowLink mock (:9090/:9091)' "cd '$Root'; node mock-server.js"

# 4) vite — 최초 실행 시 의존성 설치
Start-Service 'FlowLink frontend (:5173)' "cd '$Root\frontend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"

Write-Host ""
Write-Host "  4개 서비스 창을 띄웠습니다. 준비되면 http://localhost:5173 열기." -ForegroundColor Cyan
Write-Host ""
