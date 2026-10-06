# 기존 배포 명령을 유지한다. 릴리스 게시 구현은 desktop 모듈이 소유한다.
param(
  [string]$InstallerPath, [string]$Destination, [string]$ReleaseNotes,
  [string[]]$CompatibleServerVersions
)
& (Join-Path $PSScriptRoot '../backend/flow-desktop/installer/Publish-DesktopRelease.ps1') @PSBoundParameters
