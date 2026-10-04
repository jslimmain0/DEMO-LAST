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
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '../desktop/Apply-DesktopUpdate.ps1') -RequestFile $requestPath
        $result = Get-Content -LiteralPath (Join-Path $fixture 'result.json') -Raw | ConvertFrom-Json
        if ($result.phase -ne 'failed' -or (Test-Path -LiteralPath (Join-Path $fixture 'ready'))) { throw "Unsafe helper outcome: $scenario" }
        if ($result.targetVersion -ne '0.3.4') { throw 'Missing result release identity' }
    }
    Write-Output 'Helper rejection tests PASS (no MSI invocation or real app shutdown)'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected fixture path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
