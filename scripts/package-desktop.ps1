# 기존 배포 명령을 유지한다. 구현과 설치 자료는 desktop 모듈이 소유한다.
param(
  [string]$Type, [switch]$SkipBuild, [string]$JdkPath, [string]$WixPath,
  [string]$OutputDir, [string]$ServerUrl, [string]$ReleaseNotes, [int]$Port
)
& (Join-Path $PSScriptRoot '../backend/flow-desktop/installer/package-desktop.ps1') @PSBoundParameters
