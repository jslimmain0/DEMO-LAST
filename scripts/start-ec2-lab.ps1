param([switch]$WithRunner)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lab = Join-Path $repo '.run/ec2'
$keys = Join-Path $lab 'keys'
New-Item -ItemType Directory -Path $keys -Force > $null
$key = Join-Path $keys 'id_ed25519'
if (-not (Test-Path -LiteralPath $key)) {
    & ssh-keygen -q -t ed25519 -N '' -f $key
    if ($LASTEXITCODE -ne 0) { throw 'SSH key generation failed.' }
}
$env:FLOWLINK_DEPLOY_PUBLIC_KEY = ($key + '.pub').Replace('\','/')
$compose = Join-Path $repo 'infra/ec2/compose.yml'
& docker compose -f $compose up -d --build --wait ec2
if ($LASTEXITCODE -ne 0) { throw 'Docker EC2 startup failed.' }
$config = Join-Path $lab 'app.env'
if (-not (Test-Path -LiteralPath $config)) {
    $secret1 = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $secret2 = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $appPort = if ($env:FLOWLINK_EC2_APP_PORT) { $env:FLOWLINK_EC2_APP_PORT } else { '18088' }
    $body = @"
SPRING_PROFILES_ACTIVE=local
FLOWLINK_SITE_ADDRESS=http://:80
FLOWLINK_PUBLIC_URL=http://127.0.0.1:$appPort
FLOWLINK_PUBLIC_MCP_URL=http://127.0.0.1:$appPort/mcp
FLOWLINK_AUTH_GITHUB_ENABLED=true
FLOWLINK_AUTH_GUEST_ENABLED=false
FLOWLINK_AUTH_MOCK_LOGIN=false
FLOWLINK_AUTH_JWT_SECRET=$secret1
FLOWLINK_EXECUTION_STATE_SECRET=$secret2
FLOWLINK_H2_FILE=/home/flowlink/db/flowlink
FLOWLINK_PLUGINS_DIR=/home/flowlink/plugins
SPRING_H2_CONSOLE_ENABLED=false
"@
    [IO.File]::WriteAllText($config, $body.Replace("`r`n","`n") + "`n", [Text.UTF8Encoding]::new($false))
}
# Keep a persistent target config; never overwrite a server operator's changes.
& docker compose -f $compose exec -T ec2 test -f /opt/flowlink/.env
if ($LASTEXITCODE -ne 0) {
    & docker compose -f $compose cp $config ec2:/opt/flowlink/.env
    if ($LASTEXITCODE -ne 0) { throw 'Server configuration copy failed.' }
    & docker compose -f $compose exec -T ec2 sh -c 'chown flowlink:docker /opt/flowlink/.env && chmod 600 /opt/flowlink/.env'
    if ($LASTEXITCODE -ne 0) { throw 'Server configuration permissions failed.' }
}
$hostKey = (& docker compose -f $compose exec -T ec2 cat /etc/ssh/keys/ssh_host_ed25519_key.pub | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $hostKey -notmatch '^ssh-ed25519 ') { throw 'Could not read the container SSH host key.' }
$hostKey = ($hostKey -split '\s+')[0..1] -join ' '
$sshPort = if ($env:FLOWLINK_EC2_SSH_PORT) { $env:FLOWLINK_EC2_SSH_PORT } else { '2222' }
[IO.File]::WriteAllText((Join-Path $keys 'known_hosts'), "[127.0.0.1]:$sshPort $hostKey`nec2 $hostKey`n", [Text.UTF8Encoding]::new($false))
if ($WithRunner) {
    if (-not $env:GITHUB_REPOSITORY -or -not $env:RUNNER_TOKEN) { throw 'Set GITHUB_REPOSITORY and RUNNER_TOKEN before -WithRunner.' }
    & docker compose -f $compose --profile actions up -d --build runner
    if ($LASTEXITCODE -ne 0) { throw 'Actions runner startup failed.' }
}
Write-Output "Docker EC2 ready: SSH 127.0.0.1:$sshPort. Keys/config: $lab"
