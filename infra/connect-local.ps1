[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$LocalPort = 18080,

    [ValidateRange(1, 65535)]
    [int]$SshPort = 2222
)

$ErrorActionPreference = 'Stop'

$keyPath = Join-Path $PSScriptRoot '..\..\keys\local-ec2'
if (-not (Test-Path -LiteralPath $keyPath)) {
    throw "SSH key not found: $keyPath"
}

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/actuator/health" -TimeoutSec 2
    if ($health.status -eq 'UP') {
        Write-Host "FlowLink is already available at http://localhost:$LocalPort" -ForegroundColor Green
        exit 0
    }
}
catch {
    # The tunnel is not running yet.
}

Write-Host "Opening http://localhost:$LocalPort through the SSH tunnel."
Write-Host 'Keep this window open; press Ctrl+C to close the tunnel.'

$sshArgs = @(
    '-N'
    '-T'
    '-L', "127.0.0.1:${LocalPort}:127.0.0.1:18080"
    '-o', 'ExitOnForwardFailure=yes'
    '-o', 'ServerAliveInterval=30'
    '-o', 'ServerAliveCountMax=3'
    '-o', 'BatchMode=yes'
    # The SSH endpoint is bound to 127.0.0.1 only and its host key is
    # regenerated whenever the disposable server container is rebuilt.
    '-o', 'StrictHostKeyChecking=no'
    '-o', 'UserKnownHostsFile=NUL'
    '-i', $keyPath
    '-p', $SshPort
    'ubuntu@localhost'
)

& ssh @sshArgs

if ($LASTEXITCODE -ne 0) {
    throw "SSH tunnel closed with exit code $LASTEXITCODE."
}
