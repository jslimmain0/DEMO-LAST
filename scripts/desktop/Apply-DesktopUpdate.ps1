param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$requestPath = [IO.Path]::GetFullPath($RequestFile)
$request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
$resultPath = Join-Path (Split-Path -Parent $requestPath) 'result.json'
function Write-Result([string]$phase, [string]$message, [int]$code = -1) {
    @{phase=$phase;message=$message;exitCode=$code;targetVersion=$request.targetVersion;time=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
}
$launcher = [IO.Path]::GetFullPath([string]$request.launcher)
$installer = [IO.Path]::GetFullPath([string]$request.installer)
$restartAllowed = $false
try {
    if ([IO.Path]::GetFileName($launcher) -ne 'FlowLink.exe' -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw '앱 실행 파일을 확인하지 못했습니다.' }
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or [IO.Path]::GetExtension($installer) -ne '.msi') { throw '설치 파일을 확인하지 못했습니다.' }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$request.sha256) { throw '설치 파일 검증에 실패했습니다.' }
    $oldProcess = Get-Process -Id ([int]$request.processId) -ErrorAction SilentlyContinue
    if ($null -ne $oldProcess -and [Math]::Abs($oldProcess.StartTime.ToUniversalTime().Ticks - [long]$request.processStartTicks) -gt 10000) { throw '업데이트할 앱 프로세스가 일치하지 않습니다.' }
    Write-Result 'waiting' '앱 종료를 기다립니다.'
    [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $requestPath) 'ready'), 'ready')
    $commitPath = Join-Path (Split-Path -Parent $requestPath) 'commit'
    $commitDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $commitPath) -and [DateTime]::UtcNow -lt $commitDeadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $commitPath)) { throw '설치 승인이 전달되지 않았습니다. 설치를 시작하지 않았습니다.' }
    if ($null -ne $oldProcess -and -not $oldProcess.WaitForExit(90000)) { throw '앱이 종료되지 않았습니다. 설치를 시작하지 않았습니다.' }
    $restartAllowed = $true
    Write-Result 'installing' '설치 중입니다.'
    $logPath = Join-Path (Split-Path -Parent $requestPath) 'installer.log'
    $msiProcess = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @('/i', ('"'+$installer+'"'), '/passive', '/norestart', ('INSTALLDIR="'+(Split-Path -Parent $launcher)+'"'), '/L*v', ('"'+$logPath+'"')) -Wait -PassThru -WindowStyle Hidden
    switch ($msiProcess.ExitCode) {
        0 { Write-Result 'installed' '업데이트를 설치했습니다.' 0 }
        3010 { Write-Result 'reboot-required' '설치를 마쳤습니다. Windows 재시작이 필요합니다.' 3010 }
        1602 { Write-Result 'cancelled' '설치를 취소했습니다.' 1602 }
        default { Write-Result 'failed' '설치를 완료하지 못했습니다. 설치 로그를 확인하세요.' $msiProcess.ExitCode }
    }
} catch { Write-Result 'failed' $_.Exception.Message }
finally {
    if ($restartAllowed -and (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        try { Start-Process -FilePath $launcher -WorkingDirectory (Split-Path -Parent $launcher) -WindowStyle Hidden | Out-Null }
        catch { Write-Result 'restart-failed' '앱을 다시 열지 못했습니다. 바로가기로 실행하세요.' }
    }
}
