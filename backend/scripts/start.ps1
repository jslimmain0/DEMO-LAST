<#
.SYNOPSIS
  Flowlink 백엔드 시작 스크립트 (Windows / PowerShell).
.DESCRIPTION
  Postgres(docker compose)를 띄우고 → (필요 시)빌드 → Spring Boot 앱을 백그라운드로 실행하고
  PID/로그를 .run/ 에 기록한 뒤 헬스가 UP 될 때까지 대기한다.
.PARAMETER Build       강제 재빌드(bootJar).
.PARAMETER NoDb        Postgres(docker) 기동 생략(외부 DB 사용 시).
.PARAMETER Foreground  포그라운드로 gradlew bootRun 실행(Ctrl+C로 종료, PID 파일 미사용).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start.ps1
  powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Build -NoDb
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$NoDb,
  [switch]$Foreground,
  [switch]$H2          # 인프라 없이 H2 인메모리로 기동(Postgres/Docker 불필요)
)
$ErrorActionPreference = 'Stop'

# H2 모드: Spring 프로파일 활성 + Postgres 기동 생략
if ($H2) {
  $env:SPRING_PROFILES_ACTIVE = 'h2'
  Write-Host "H2 인메모리 모드 (프로파일=h2, Postgres 생략)" -ForegroundColor Magenta
}

$Backend = Split-Path -Parent $PSScriptRoot
$Port    = if ($env:FLOWLINK_PORT) { $env:FLOWLINK_PORT } else { 18080 }
$RunDir  = Join-Path $Backend '.run'
$PidFile = Join-Path $RunDir 'flowlink.pid'
$OutLog  = Join-Path $RunDir 'flowlink.out.log'
$ErrLog  = Join-Path $RunDir 'flowlink.err.log'
$Jar     = Join-Path $Backend 'build\libs\flowlink.jar'
$Gradlew = Join-Path $Backend 'gradlew.bat'
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

function Test-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# JDK 자동 감지: PATH → JAVA_HOME → %USERPROFILE%\.jdks\*(21 우선). 찾으면 JAVA_HOME/PATH 설정.
function Resolve-Jdk {
  if (Test-Cmd 'java') { return }
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    $env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH; return
  }
  $jdksRoot = Join-Path $env:USERPROFILE '.jdks'
  if (Test-Path $jdksRoot) {
    $cand = Get-ChildItem $jdksRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } |
      Sort-Object @{ Expression = { if ($_.Name -match '21') { 0 } else { 1 } } }, Name |
      Select-Object -First 1
    if ($cand) {
      $env:JAVA_HOME = $cand.FullName
      $env:PATH = (Join-Path $cand.FullName 'bin') + ';' + $env:PATH
      Write-Host "JDK 자동 감지: $($cand.FullName)" -ForegroundColor DarkGray
    }
  }
}

# 0) 사전 요구사항
Resolve-Jdk
if (-not (Test-Cmd 'java')) {
  throw "java(JDK 21)를 찾을 수 없습니다. JAVA_HOME 설정 또는 설치: winget install EclipseAdoptium.Temurin.21.JDK"
}
$JavaExe = if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
  Join-Path $env:JAVA_HOME 'bin\java.exe'
} else { 'java' }

# 1) 이미 실행 중인지 확인
if (Test-Path $PidFile) {
  $existing = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
    Write-Host "이미 실행 중입니다 (PID $existing). 먼저 stop.ps1 을 실행하세요." -ForegroundColor Yellow
    return
  }
}

# 2) Postgres (docker) — H2 모드에서는 생략
if (-not $NoDb -and -not $H2) {
  if (Test-Cmd 'docker') {
    Write-Host "Postgres 기동 (docker compose up -d)..." -ForegroundColor Cyan
    Push-Location $Backend
    try { docker compose up -d } finally { Pop-Location }
    Write-Host -NoNewline "Postgres 헬스 대기"
    $dbReady = $false
    for ($i = 0; $i -lt 30; $i++) {
      docker exec flowlink-postgres pg_isready -U flowlink -d flowlink 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $dbReady = $true; break }
      Start-Sleep -Seconds 2; Write-Host -NoNewline "."
    }
    Write-Host ""
    if (-not $dbReady) { Write-Warning "Postgres 준비 확인 실패 — 계속 진행합니다(외부 DB일 수 있음)." }
  } else {
    Write-Warning "docker 가 없습니다 — Postgres 기동을 건너뜁니다. 외부 DB가 떠 있어야 합니다(FLOWLINK_DB_URL)."
  }
}

# 3) 빌드
if ($Build -or -not (Test-Path $Jar)) {
  Write-Host "빌드 (gradlew bootJar)..." -ForegroundColor Cyan
  Push-Location $Backend
  try { & $Gradlew bootJar } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "빌드 실패 (exit $LASTEXITCODE)" }
}

# 4) 포그라운드 모드
if ($Foreground) {
  Write-Host "포그라운드 실행 (Ctrl+C 로 종료)" -ForegroundColor Green
  Push-Location $Backend
  try { & $Gradlew bootRun } finally { Pop-Location }
  return
}

# 4') 백그라운드 실행
# 주의: -ArgumentList 배열은 공백 인자를 따옴표로 감싸지 않으므로(경로에 공백 시 분리됨),
# jar 경로를 직접 따옴표로 감싼 단일 문자열로 전달한다.
Write-Host "백그라운드 실행..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $JavaExe -ArgumentList "-jar `"$Jar`"" `
  -WorkingDirectory $Backend -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog `
  -PassThru -WindowStyle Hidden
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii
Write-Host "시작됨 (PID $($proc.Id)). 로그: $OutLog" -ForegroundColor Green

# 5) 헬스 대기
Write-Host -NoNewline "앱 헬스 대기 (http://localhost:$Port/actuator/health)"
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
    Write-Host ""
    throw "앱이 비정상 종료되었습니다. 로그 확인: $ErrLog"
  }
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$Port/actuator/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $up = $true; break }
  } catch { }
  Start-Sleep -Seconds 2; Write-Host -NoNewline "."
}
Write-Host ""
if ($up) {
  Write-Host "READY ✓  → http://localhost:$Port/swagger-ui.html" -ForegroundColor Green
} else {
  Write-Warning "헬스 확인 시간 초과. 로그를 확인하세요: $OutLog / $ErrLog"
}





