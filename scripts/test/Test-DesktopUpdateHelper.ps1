$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('flowlink-updater-test-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $launcher = Join-Path $fixture 'FlowLink.exe'; [IO.File]::WriteAllText($launcher,'not executable')
    $installer = Join-Path $fixture 'fixture.msi'; [IO.File]::WriteAllText($installer,'not MSI')
    $requestPath = Join-Path $fixture 'request.json'
    foreach ($scenario in @('wrong-hash','wrong-process')) {
        $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($scenario -eq 'wrong-hash') { $hash = '0' * 64 }
        @{launcher=$launcher;installer=$installer;sha256=$hash;processId=$PID;processStartTicks='1';targetVersion='0.3.4'} | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '../../backend/flow-desktop/installer/Apply-DesktopUpdate.ps1') -RequestFile $requestPath
        $result = Get-Content -LiteralPath (Join-Path $fixture 'result.json') -Raw | ConvertFrom-Json
        if ($result.phase -ne 'failed' -or (Test-Path -LiteralPath (Join-Path $fixture 'ready'))) { throw "Unsafe helper outcome: $scenario" }
        if ($result.targetVersion -ne '0.3.4') { throw 'Missing result release identity' }
    }
    # 실제 MSI/앱을 실행하지 않고 설치 결과와 재실행 실패의 기록만 검증한다.
    function Get-Process { param($Id, $ErrorAction) return $null }
    function Start-Process {
        param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru, $WindowStyle, $WorkingDirectory)
        if ($WindowStyle -ne 'Hidden') { throw 'Helper must keep background launches hidden' }
        if ([IO.Path]::GetFileName($FilePath) -eq 'msiexec.exe') { return [pscustomobject]@{ ExitCode = $script:fixtureExitCode } }
        if ($FilePath -eq $launcher) { throw 'Fixture launcher deliberately fails' }
        throw 'Unexpected process launch'
    }
    foreach ($case in @(@{code=0;phase='installed'}, @{code=3010;phase='reboot-required'}, @{code=1602;phase='cancelled'}, @{code=1603;phase='failed'})) {
        $script:fixtureExitCode = $case.code
        $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
        @{launcher=$launcher;installer=$installer;sha256=$hash;processId=0;processStartTicks='1';targetVersion='0.3.4'} | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
        [IO.File]::WriteAllText((Join-Path $fixture 'commit'), 'install')
        . (Join-Path $PSScriptRoot '../../backend/flow-desktop/installer/Apply-DesktopUpdate.ps1') -RequestFile $requestPath
        $result = Get-Content -LiteralPath (Join-Path $fixture 'result.json') -Raw | ConvertFrom-Json
        if ($result.phase -ne $case.phase -or $result.exitCode -ne $case.code) { throw "Installer receipt overwritten after restart failure: $($case.code)" }
        if (-not (Test-Path -LiteralPath (Join-Path $fixture 'restart-error.txt'))) { throw 'Missing separate restart recovery notice' }
    }
    Write-Output 'Helper rejection tests PASS (no MSI invocation or real app shutdown)'
    Write-Output 'Helper receipt tests PASS (simulated success, reboot, cancellation, failure and launcher failure)'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
