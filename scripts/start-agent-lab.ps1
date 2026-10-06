param([switch]$Build)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $PSScriptRoot
$PrivateDir = Join-Path $Repo '.run/agent-lab'
$SecretFile = Join-Path $PrivateDir 'secrets.env'
New-Item -ItemType Directory -Path $PrivateDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PrivateDir 'downloads') -Force | Out-Null
$Owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$Acl = New-Object System.Security.AccessControl.DirectorySecurity
$Acl.SetAccessRuleProtection($true, $false)
$Acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($Owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -LiteralPath $PrivateDir -AclObject $Acl
if (-not (Test-Path -LiteralPath $SecretFile)) {
    $Bytes = New-Object byte[] 32
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
    [System.IO.File]::WriteAllText($SecretFile, "FLOWLINK_EXECUTION_STATE_SECRET=$([Convert]::ToBase64String($Bytes))`n", (New-Object System.Text.UTF8Encoding($false)))
}
if ($Build) {
    Push-Location (Join-Path $Repo 'frontend')
    try {
        & npm ci; if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed' }
        & npm run build; if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
    } finally { Pop-Location }
    Push-Location (Join-Path $Repo 'backend')
    try { & .\gradlew.bat :flow-server:bootJar; if ($LASTEXITCODE -ne 0) { throw 'App build failed' } } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $Repo 'backend/flow-server/build/libs/flowlink-server.jar'))) {
    throw 'Build artifacts are missing; run start-agent-lab.ps1 -Build with JDK 21 and Node 24+.'
}
& docker compose -f (Join-Path $Repo 'infra/agent-lab.compose.yml') up -d --build --wait --wait-timeout 150
if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed; inspect docker compose logs.' }
Write-Host 'Server UI: http://127.0.0.1:18080 (development mock login)'
Write-Host 'Native Windows installer: http://127.0.0.1:18080/downloads/FlowLink.msi'
